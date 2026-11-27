import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

export type Rot = readonly [number, number, number];
const NO_ROT: Rot = [0, 0, 0];

const _local = new THREE.Matrix4();
const _quat = new THREE.Quaternion();
const _euler = new THREE.Euler();
const _pos = new THREE.Vector3();
const _scale = new THREE.Vector3();

/**
 * Collects many small transformed primitives and merges them into one mesh per material, so a whole
 * workshop of props costs a few dozen draw calls instead of thousands.
 */
export class MeshBatcher {
  private readonly buckets = new Map<THREE.Material, THREE.BufferGeometry[]>();
  private readonly worldUv = new Map<THREE.Material, number>();
  private frame = new THREE.Matrix4();

  /** Marks a material as textured in world units: its UVs are projected from position, `metersPerTile` apart. */
  useWorldUv(material: THREE.Material, metersPerTile: number): this {
    this.worldUv.set(material, metersPerTile);
    return this;
  }

  /** Runs `build` with everything it adds placed relative to a local frame (position + yaw). */
  at(x: number, y: number, z: number, yaw: number, build: () => void): void {
    const saved = this.frame;
    _local.compose(_pos.set(x, y, z), _quat.setFromEuler(_euler.set(0, yaw, 0)), _scale.set(1, 1, 1));
    this.frame = saved.clone().multiply(_local);
    build();
    this.frame = saved;
  }

  /** Adds any geometry. The batcher takes ownership of it. */
  add(material: THREE.Material, geometry: THREE.BufferGeometry, x = 0, y = 0, z = 0, rot: Rot = NO_ROT, scale: Rot | number = 1): void {
    let g = geometry;
    if (g.index) {
      g = geometry.toNonIndexed();
      geometry.dispose();
    }
    for (const name of Object.keys(g.attributes)) {
      if (name !== 'position' && name !== 'normal' && name !== 'uv') g.deleteAttribute(name);
    }
    if (!g.attributes.normal) g.computeVertexNormals();
    if (!g.attributes.uv) {
      g.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(g.attributes.position.count * 2), 2));
    }
    if (typeof scale === 'number') _scale.set(scale, scale, scale);
    else _scale.set(scale[0], scale[1], scale[2]);
    _local.compose(_pos.set(x, y, z), _quat.setFromEuler(_euler.set(rot[0], rot[1], rot[2])), _scale);
    g.applyMatrix4(_local.premultiply(this.frame));
    let bucket = this.buckets.get(material);
    if (!bucket) {
      bucket = [];
      this.buckets.set(material, bucket);
    }
    bucket.push(g);
  }

  /** Box centered on (x, y, z). */
  box(material: THREE.Material, w: number, h: number, d: number, x: number, y: number, z: number, rot: Rot = NO_ROT): void {
    this.add(material, new THREE.BoxGeometry(w, h, d), x, y, z, rot);
  }

  /** Box standing on `yBottom`. */
  slab(material: THREE.Material, w: number, h: number, d: number, x: number, yBottom: number, z: number, rot: Rot = NO_ROT): void {
    this.add(material, new THREE.BoxGeometry(w, h, d), x, yBottom + h / 2, z, rot);
  }

  /** Cylinder centered on (x, y, z). `axis` picks which way its length runs. */
  cyl(
    material: THREE.Material,
    radius: number,
    length: number,
    x: number,
    y: number,
    z: number,
    axis: 'x' | 'y' | 'z' = 'y',
    options: { radiusTop?: number; segments?: number; open?: boolean } = {},
  ): void {
    const g = new THREE.CylinderGeometry(options.radiusTop ?? radius, radius, length, options.segments ?? 20, 1, options.open ?? false);
    const rot: Rot = axis === 'x' ? [0, 0, Math.PI / 2] : axis === 'z' ? [Math.PI / 2, 0, 0] : NO_ROT;
    this.add(material, g, x, y, z, rot);
  }

  /** A bar between two points, used for braces, hoses and rails. */
  beam(material: THREE.Material, from: readonly [number, number, number], to: readonly [number, number, number], width: number, depth = width): void {
    const a = new THREE.Vector3(...from);
    const b = new THREE.Vector3(...to);
    const length = a.distanceTo(b);
    if (length < 1e-4) return;
    const g = new THREE.BoxGeometry(width, length, depth);
    const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), b.clone().sub(a).normalize());
    g.applyQuaternion(q);
    const mid = a.add(b).multiplyScalar(0.5);
    this.add(material, g, mid.x, mid.y, mid.z);
  }

  /** Flat rectangle lying on the floor (facing up), `w` along X and `d` along Z. */
  decal(material: THREE.Material, w: number, d: number, x: number, y: number, z: number, yaw = 0): void {
    this.add(material, new THREE.PlaneGeometry(w, d), x, y, z, [-Math.PI / 2, 0, yaw]);
  }

  /** Vertical rectangle facing along +Z before `yaw` is applied. */
  panel(material: THREE.Material, w: number, h: number, x: number, y: number, z: number, yaw = 0): void {
    this.add(material, new THREE.PlaneGeometry(w, h), x, y, z, [0, yaw, 0]);
  }

  /** Merges everything added so far into one mesh per material. */
  build(name: string, options: { castShadow?: boolean; receiveShadow?: boolean } = {}): THREE.Group {
    const group = new THREE.Group();
    group.name = name;
    for (const [material, geometries] of this.buckets) {
      const tile = this.worldUv.get(material);
      if (tile) for (const g of geometries) projectWorldUv(g, tile);
      const merged = mergeGeometries(geometries, false);
      for (const g of geometries) g.dispose();
      if (!merged) continue;
      const mesh = new THREE.Mesh(merged, material);
      mesh.name = `${name}:${material.name || 'material'}`;
      mesh.castShadow = options.castShadow ?? false;
      mesh.receiveShadow = options.receiveShadow ?? true;
      mesh.matrixAutoUpdate = false;
      group.add(mesh);
    }
    this.buckets.clear();
    return group;
  }
}

/** Box-projects UVs from world position so tiling textures keep a real-world scale on any surface. */
function projectWorldUv(geometry: THREE.BufferGeometry, metersPerTile: number): void {
  const pos = geometry.attributes.position;
  const nor = geometry.attributes.normal;
  const uv = geometry.attributes.uv;
  const k = 1 / metersPerTile;
  for (let i = 0; i < pos.count; i++) {
    const ax = Math.abs(nor.getX(i));
    const ay = Math.abs(nor.getY(i));
    const az = Math.abs(nor.getZ(i));
    if (ay >= ax && ay >= az) uv.setXY(i, pos.getX(i) * k, pos.getZ(i) * k);
    else if (ax >= az) uv.setXY(i, pos.getZ(i) * k, pos.getY(i) * k);
    else uv.setXY(i, pos.getX(i) * k, pos.getY(i) * k);
  }
}
