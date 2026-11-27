import * as THREE from 'three';
import type { MeshRecord } from './analysis';
import { texturesOf } from './materialFixes';

/**
 * Coarse map of the car's outer surface, filled for free while meshes are being merged. It answers
 * the questions procedural bolt-on parts need (how high is the tail deck here, where does the nose
 * end, how far off the floor are the sills) without ever raycasting millions of triangles.
 */
export class HeightField {
  static readonly CELL = 0.04;
  readonly nx: number;
  readonly nz: number;
  readonly top: Float32Array;
  readonly bottom: Float32Array;

  constructor(readonly bounds: THREE.Box3) {
    this.nx = Math.max(1, Math.ceil((bounds.max.x - bounds.min.x) / HeightField.CELL));
    this.nz = Math.max(1, Math.ceil((bounds.max.z - bounds.min.z) / HeightField.CELL));
    this.top = new Float32Array(this.nx * this.nz).fill(-Infinity);
    this.bottom = new Float32Array(this.nx * this.nz).fill(Infinity);
  }

  private ix(x: number): number {
    return Math.min(this.nx - 1, Math.max(0, Math.floor((x - this.bounds.min.x) / HeightField.CELL)));
  }

  private iz(z: number): number {
    return Math.min(this.nz - 1, Math.max(0, Math.floor((z - this.bounds.min.z) / HeightField.CELL)));
  }

  /** Highest surface within `radius` of (x, z), or `fallback` where the car has no geometry. */
  topAt(x: number, z: number, radius = 0.06, fallback = 0): number {
    let best = -Infinity;
    for (let i = this.ix(x - radius); i <= this.ix(x + radius); i++) {
      for (let k = this.iz(z - radius); k <= this.iz(z + radius); k++) best = Math.max(best, this.top[k * this.nx + i]);
    }
    return Number.isFinite(best) ? best : fallback;
  }

  /** Lowest surface within `radius` of (x, z), or `fallback` where the car has no geometry. */
  bottomAt(x: number, z: number, radius = 0.06, fallback = 0.15): number {
    let best = Infinity;
    for (let i = this.ix(x - radius); i <= this.ix(x + radius); i++) {
      for (let k = this.iz(z - radius); k <= this.iz(z + radius); k++) best = Math.min(best, this.bottom[k * this.nx + i]);
    }
    return Number.isFinite(best) ? best : fallback;
  }

  /**
   * How far the body reaches toward the nose (`direction` 1) or the tail (-1) along the line x,
   * counting only cells that have surface between `minY` and `maxY`.
   */
  edge(x: number, direction: 1 | -1, minY: number, maxY: number, halfWidth = 0.06): number {
    const i0 = this.ix(x - halfWidth);
    const i1 = this.ix(x + halfWidth);
    for (let step = 0; step < this.nz; step++) {
      const k = direction === 1 ? this.nz - 1 - step : step;
      for (let i = i0; i <= i1; i++) {
        const c = k * this.nx + i;
        if (this.bottom[c] <= maxY && this.top[c] >= minY) return this.bounds.min.z + (k + (direction === 1 ? 1 : 0)) * HeightField.CELL;
      }
    }
    return direction === 1 ? this.bounds.max.z : this.bounds.min.z;
  }
}

const UV_NAMES = ['uv', 'uv1', 'uv2', 'uv3'] as const;
const _normalMatrix = new THREE.Matrix3();
const _toTarget = new THREE.Matrix4();

export interface MergeResult {
  meshes: THREE.Mesh[];
  triangles: number;
}

/**
 * Merges many small meshes into one mesh per material, in the frame given by `targetInverse`
 * (the inverse of the destination group's car-frame transform).
 *
 * A real .blend car arrives as 200 to 2,400 separate meshes sharing 30 to 280 materials. Drawn as-is
 * that is thousands of draw calls a frame, twice with shadows, which is what holds the frame rate
 * down rather than the triangle count. Merged, the same car is a few dozen draws.
 */
export function mergeByMaterial(records: MeshRecord[], targetInverse: THREE.Matrix4, name: string, field?: HeightField): MergeResult {
  const groups = new Map<THREE.Material, MeshRecord[]>();
  for (const record of records) {
    const material = record.mesh.material as THREE.Material;
    const list = groups.get(material);
    if (list) list.push(record);
    else groups.set(material, [record]);
  }

  const meshes: THREE.Mesh[] = [];
  let triangles = 0;
  for (const [material, group] of groups) {
    const channels = new Set<number>();
    for (const texture of texturesOf(material)) channels.add(Math.min(3, Math.max(0, texture.channel)));
    const wantsColor = (material as THREE.MeshStandardMaterial).vertexColors === true;

    let vertexCount = 0;
    let indexCount = 0;
    let colorSize = 3;
    for (const { mesh } of group) {
      const g = mesh.geometry as THREE.BufferGeometry;
      vertexCount += g.attributes.position.count;
      indexCount += g.index ? g.index.count : g.attributes.position.count;
      if (wantsColor && g.attributes.color?.itemSize === 4) colorSize = 4;
    }
    if (!vertexCount || !indexCount) continue;

    const positions = new Float32Array(vertexCount * 3);
    const normals = new Float32Array(vertexCount * 3);
    const uvs = new Map<number, Float32Array>();
    for (const channel of channels) uvs.set(channel, new Float32Array(vertexCount * 2));
    const colors = wantsColor ? new Float32Array(vertexCount * colorSize).fill(1) : null;
    const indices = vertexCount > 65535 ? new Uint32Array(indexCount) : new Uint16Array(indexCount);
    const box = new THREE.Box3();

    let v0 = 0;
    let i0 = 0;
    for (const { mesh, matrix } of group) {
      const g = mesh.geometry as THREE.BufferGeometry;
      const pos = g.attributes.position;
      const count = pos.count;
      _toTarget.multiplyMatrices(targetInverse, matrix);
      const e = _toTarget.elements;
      const mirrored = _toTarget.determinant() < 0;

      const fastPos = pos instanceof THREE.BufferAttribute && pos.array instanceof Float32Array && !pos.normalized ? pos.array : null;
      for (let i = 0; i < count; i++) {
        const x = fastPos ? fastPos[i * 3] : pos.getX(i);
        const y = fastPos ? fastPos[i * 3 + 1] : pos.getY(i);
        const z = fastPos ? fastPos[i * 3 + 2] : pos.getZ(i);
        const o = (v0 + i) * 3;
        const px = e[0] * x + e[4] * y + e[8] * z + e[12];
        const py = e[1] * x + e[5] * y + e[9] * z + e[13];
        const pz = e[2] * x + e[6] * y + e[10] * z + e[14];
        positions[o] = px;
        positions[o + 1] = py;
        positions[o + 2] = pz;
        if (px < box.min.x) box.min.x = px;
        if (py < box.min.y) box.min.y = py;
        if (pz < box.min.z) box.min.z = pz;
        if (px > box.max.x) box.max.x = px;
        if (py > box.max.y) box.max.y = py;
        if (pz > box.max.z) box.max.z = pz;
      }
      if (field) {
        // `matrix` alone is the car-frame transform, which is what the height field is laid out in.
        const c = matrix.elements;
        const fx = field.bounds.min.x;
        const fz = field.bounds.min.z;
        const inv = 1 / HeightField.CELL;
        for (let i = 0; i < count; i++) {
          const x = fastPos ? fastPos[i * 3] : pos.getX(i);
          const y = fastPos ? fastPos[i * 3 + 1] : pos.getY(i);
          const z = fastPos ? fastPos[i * 3 + 2] : pos.getZ(i);
          const wx = c[0] * x + c[4] * y + c[8] * z + c[12];
          const wy = c[1] * x + c[5] * y + c[9] * z + c[13];
          const wz = c[2] * x + c[6] * y + c[10] * z + c[14];
          const ix = Math.min(field.nx - 1, Math.max(0, Math.floor((wx - fx) * inv)));
          const iz = Math.min(field.nz - 1, Math.max(0, Math.floor((wz - fz) * inv)));
          const cell = iz * field.nx + ix;
          if (wy > field.top[cell]) field.top[cell] = wy;
          if (wy < field.bottom[cell]) field.bottom[cell] = wy;
        }
      }

      const nor = g.attributes.normal;
      if (nor) {
        _normalMatrix.getNormalMatrix(_toTarget);
        const n = _normalMatrix.elements;
        const fastNor = nor instanceof THREE.BufferAttribute && nor.array instanceof Float32Array && !nor.normalized ? nor.array : null;
        for (let i = 0; i < count; i++) {
          const x = fastNor ? fastNor[i * 3] : nor.getX(i);
          const y = fastNor ? fastNor[i * 3 + 1] : nor.getY(i);
          const z = fastNor ? fastNor[i * 3 + 2] : nor.getZ(i);
          let nx = n[0] * x + n[3] * y + n[6] * z;
          let ny = n[1] * x + n[4] * y + n[7] * z;
          let nz = n[2] * x + n[5] * y + n[8] * z;
          const len = Math.hypot(nx, ny, nz) || 1;
          nx /= len;
          ny /= len;
          nz /= len;
          const o = (v0 + i) * 3;
          normals[o] = nx;
          normals[o + 1] = ny;
          normals[o + 2] = nz;
        }
      }

      for (const [channel, out] of uvs) {
        const uv = g.attributes[UV_NAMES[channel]] ?? g.attributes.uv;
        if (!uv) continue;
        for (let i = 0; i < count; i++) {
          out[(v0 + i) * 2] = uv.getX(i);
          out[(v0 + i) * 2 + 1] = uv.getY(i);
        }
      }

      if (colors && g.attributes.color) {
        const color = g.attributes.color;
        for (let i = 0; i < count; i++) {
          const o = (v0 + i) * colorSize;
          colors[o] = color.getX(i);
          colors[o + 1] = color.getY(i);
          colors[o + 2] = color.getZ(i);
          if (colorSize === 4 && color.itemSize === 4) colors[o + 3] = color.getW(i);
        }
      }

      const index = g.index;
      const n = index ? index.count : count;
      for (let i = 0; i + 2 < n; i += 3) {
        const a = (index ? index.getX(i) : i) + v0;
        const b = (index ? index.getX(i + 1) : i + 1) + v0;
        const c = (index ? index.getX(i + 2) : i + 2) + v0;
        indices[i0 + i] = a;
        // A mirrored transform turns triangles inside out; swapping two corners puts them back.
        indices[i0 + i + 1] = mirrored ? c : b;
        indices[i0 + i + 2] = mirrored ? b : c;
      }
      v0 += count;
      i0 += n - (n % 3);
    }

    const merged = new THREE.BufferGeometry();
    merged.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    merged.setAttribute('normal', new THREE.BufferAttribute(normals, 3));
    for (const [channel, out] of uvs) merged.setAttribute(UV_NAMES[channel], new THREE.BufferAttribute(out, 2));
    if (colors) merged.setAttribute('color', new THREE.BufferAttribute(colors, colorSize));
    merged.setIndex(new THREE.BufferAttribute(i0 === indices.length ? indices : indices.subarray(0, i0), 1));
    merged.boundingBox = box;
    merged.boundingSphere = box.getBoundingSphere(new THREE.Sphere());

    const mesh = new THREE.Mesh(merged, material);
    mesh.name = `${name}:${material.name}`;
    mesh.castShadow = !material.transparent;
    mesh.receiveShadow = !material.transparent;
    meshes.push(mesh);
    triangles += i0 / 3;
  }
  return { meshes, triangles };
}
