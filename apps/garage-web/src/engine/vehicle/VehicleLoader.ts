import * as THREE from 'three';
import { DRACOLoader } from 'three/examples/jsm/loaders/DRACOLoader.js';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import type { VehicleManifest } from '@blend-garage/vehicle-core';
import { withBase } from '../catalog';
import type { LoadPhase } from '../types';
import { resolveUnmappableTextures, texturesOf } from './materialFixes';
import { VehicleRig, type RigResources } from './VehicleRig';

function disposeParsedScene(scene: THREE.Object3D): void {
  const materials = new Set<THREE.Material>();
  scene.traverse((o) => {
    if (!(o instanceof THREE.Mesh)) return;
    o.geometry.dispose();
    for (const m of Array.isArray(o.material) ? o.material : [o.material]) materials.add(m);
  });
  for (const material of materials) {
    for (const texture of texturesOf(material)) {
      texture.dispose();
      const image = texture.source?.data as { close?: () => void } | undefined;
      if (image && typeof image.close === 'function') image.close();
    }
    material.dispose();
  }
}

function isAbort(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError';
}

/**
 * Loads one car at a time.
 *
 * These models are 1 to 38 MB of Draco data that unpack to as many as 5.8 million triangles, so a
 * load is never allowed to pile up behind another: starting a load aborts the download in flight,
 * a finished download is dropped if the user has already moved on, and decoding is serialized so
 * two cars are never unpacked at the same time.
 */
export class VehicleLoader {
  private readonly draco = new DRACOLoader();
  private readonly gltf = new GLTFLoader();
  private generation = 0;
  private download: AbortController | null = null;
  private decoding: Promise<unknown> | null = null;

  constructor() {
    this.draco.setDecoderPath(withBase('/draco/'));
    this.draco.preload();
    this.gltf.setDRACOLoader(this.draco);
  }

  /** Abandons whatever is loading. Its promise resolves to `null`. */
  cancel(): void {
    this.generation += 1;
    this.download?.abort();
    this.download = null;
  }

  /**
   * Downloads, decodes and prepares a car. Resolves to `null` if another load (or `cancel`) superseded
   * this one; rejects only for real failures.
   */
  async load(manifest: VehicleManifest, resources: RigResources, onState: (phase: LoadPhase, progress: number) => void): Promise<VehicleRig | null> {
    this.cancel();
    const id = this.generation;
    const stale = () => id !== this.generation;
    const controller = new AbortController();
    this.download = controller;

    const modelUrl = withBase(manifest.modelUrl);
    let buffer: ArrayBuffer;
    try {
      onState('download', 0);
      const response = await fetch(modelUrl, { signal: controller.signal });
      if (!response.ok) throw new Error(`The model file could not be downloaded (HTTP ${response.status}). Run "npm run import-cars" to rebuild it.`);
      const total = Number(response.headers.get('content-length')) || 0;
      if (response.body) {
        const reader = response.body.getReader();
        const chunks: Uint8Array[] = [];
        let received = 0;
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          chunks.push(value);
          received += value.length;
          if (total > 0) {
            onState('download', Math.min(1, received / total) * 0.55);
          }
        }
        const bytes = new Uint8Array(received);
        let offset = 0;
        for (const chunk of chunks) {
          bytes.set(chunk, offset);
          offset += chunk.length;
        }
        buffer = bytes.buffer;
      } else {
        buffer = await response.arrayBuffer();
      }
    } catch (error) {
      if (isAbort(error) || stale()) return null;
      throw error;
    }
    if (stale()) return null;

    // Let a decode that is already running finish before starting another.
    while (this.decoding) await this.decoding.catch(() => undefined);
    if (stale()) return null;

    onState('decode', 0.6);
    const basePath = modelUrl.slice(0, modelUrl.lastIndexOf('/') + 1);
    const decode = this.gltf.parseAsync(buffer, basePath);
    this.decoding = decode;
    let scene: THREE.Object3D;
    try {
      const gltf = await decode;
      resolveUnmappableTextures(gltf.parser);
      scene = gltf.scene;
    } catch (error) {
      throw new Error(`The model file could not be read: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      if (this.decoding === decode) this.decoding = null;
    }
    if (stale()) {
      disposeParsedScene(scene);
      return null;
    }

    onState('prepare', 0.72);
    return VehicleRig.build(scene, manifest, resources, {
      onProgress: (fraction) => onState('prepare', 0.72 + fraction * 0.28),
      isStale: stale,
    });
  }

  dispose(): void {
    this.cancel();
    this.draco.dispose();
  }
}
