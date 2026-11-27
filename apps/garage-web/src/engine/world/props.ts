import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { BoxColliderDef, CylinderColliderDef, TrimeshColliderDef, WorldColliderDef } from '@blend-garage/world-racing';
import { clamp, lerp, seededRandom } from '../math';
import { MeshBatcher } from '../MeshBatcher';
import { createFoliageAndPropTextures } from './foliageTextures';
import {
  COAST_BRIDGE_BOUNDS,
  TUNNEL_BOUNDS,
  isInsideTunnelCoords,
  isOnCoastBridgeSpan,
  type RoadNetwork,
} from './roads';
import { alpineBiomeWeight, desertBiomeWeight, type TerrainData } from './terrain';
import type { WorldTextures } from './textures';
import { OCEAN_LEVEL, shorelineXAtZ } from './water';

export interface DistanceCullSector {
  object: THREE.Object3D;
  cx: number;
  cz: number;
  maxDistSq: number;
}

export interface WorldPropsResult {
  group: THREE.Group;
  geometries: THREE.BufferGeometry[];
  materials: THREE.Material[];
  colliders: WorldColliderDef[];
  cullableSectors: DistanceCullSector[];
}

/**
 * Splits a world-spanning collection of instanced transforms into tight spatial sectors so
 * Three.js frustum culling skips out-of-view sectors in BOTH the main pass and the 60m shadow pass.
 */
function addChunkedInstances(
  parent: THREE.Group,
  geometry: THREE.BufferGeometry,
  material: THREE.Material,
  namePrefix: string,
  matrices: readonly THREE.Matrix4[],
  colors: readonly THREE.Color[] | null,
  options: {
    sectorSize: number;
    castShadow: boolean;
    receiveShadow: boolean;
    maxDistance?: number;
    cullList?: DistanceCullSector[];
  },
): void {
  if (matrices.length === 0) return;
  const invSector = 1 / options.sectorSize;
  const buckets = new Map<string, number[]>();

  for (let i = 0; i < matrices.length; i++) {
    const e = matrices[i].elements;
    const sx = Math.floor(e[12] * invSector);
    const sz = Math.floor(e[14] * invSector);
    const key = `${sx},${sz}`;
    let list = buckets.get(key);
    if (!list) {
      list = [];
      buckets.set(key, list);
    }
    list.push(i);
  }

  let sectorIndex = 0;
  for (const indices of buckets.values()) {
    const inst = new THREE.InstancedMesh(geometry, material, indices.length);
    inst.name = `${namePrefix}:${sectorIndex++}`;
    inst.castShadow = options.castShadow;
    inst.receiveShadow = options.receiveShadow;
    inst.matrixAutoUpdate = false;

    for (let k = 0; k < indices.length; k++) {
      const srcIdx = indices[k];
      inst.setMatrixAt(k, matrices[srcIdx]);
      if (colors) inst.setColorAt(k, colors[srcIdx]);
    }
    inst.instanceMatrix.needsUpdate = true;
    if (inst.instanceColor) inst.instanceColor.needsUpdate = true;
    inst.computeBoundingBox();
    inst.computeBoundingSphere();
    parent.add(inst);

    if (options.maxDistance !== undefined && options.cullList && inst.boundingSphere) {
      const bs = inst.boundingSphere;
      const effDist = options.maxDistance + bs.radius;
      options.cullList.push({
        object: inst,
        cx: bs.center.x,
        cz: bs.center.z,
        maxDistSq: effDist * effDist,
      });
    }
  }
}

// ---------------------------------------------------------------------------
// Procedural Geometry Helpers (Pure TypeScript + Three.js)
// ---------------------------------------------------------------------------

/** Normalizes and merges geometries while preserving `position`, `normal`, `uv`, and `color`. */
function mergeColoredParts(parts: THREE.BufferGeometry[]): THREE.BufferGeometry {
  const normalized: THREE.BufferGeometry[] = [];
  for (const raw of parts) {
    const g = raw.index ? raw.toNonIndexed() : raw;
    if (raw.index) raw.dispose();

    for (const key of Object.keys(g.attributes)) {
      if (key !== 'position' && key !== 'normal' && key !== 'uv' && key !== 'color') {
        g.deleteAttribute(key);
      }
    }
    const count = g.attributes.position.count;
    if (!g.attributes.normal) g.computeVertexNormals();
    if (!g.attributes.uv) {
      g.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(count * 2), 2));
    }
    if (!g.attributes.color) {
      const col = new Float32Array(count * 3);
      col.fill(1);
      g.setAttribute('color', new THREE.BufferAttribute(col, 3));
    }
    normalized.push(g);
  }
  const merged = mergeGeometries(normalized, false);
  for (const g of normalized) g.dispose();
  if (!merged) {
    throw new Error('Failed to merge procedural prop geometry parts');
  }
  return merged;
}

/** Paints a uniform sRGB-converted linear color onto all vertices of a geometry. */
function tintGeometry(geo: THREE.BufferGeometry, hex: number): THREE.BufferGeometry {
  const c = new THREE.Color(hex);
  const count = geo.attributes.position.count;
  const arr = new Float32Array(count * 3);
  for (let i = 0; i < count; i++) {
    arr[i * 3] = c.r;
    arr[i * 3 + 1] = c.g;
    arr[i * 3 + 2] = c.b;
  }
  geo.setAttribute('color', new THREE.BufferAttribute(arr, 3));
  return geo;
}

/**
 * Sweeps a tapered organic bark tube along a 3D polyline with smooth cylindrical normals,
 * tiled bark UVs, and root/crotch AO vertex colors.
 */
function buildTaperedBranchTube(
  points: readonly THREE.Vector3[],
  radii: readonly number[],
  radialSegs: number,
  uvTileV = 0.55,
  baseAo = 0.58,
  tipAo = 0.96,
): THREE.BufferGeometry {
  const rings = points.length;
  const cols = radialSegs + 1;
  const positions = new Float32Array(rings * cols * 3);
  const normals = new Float32Array(rings * cols * 3);
  const uvs = new Float32Array(rings * cols * 2);
  const colors = new Float32Array(rings * cols * 3);
  const indices: number[] = [];

  const tangent = new THREE.Vector3();
  const prevNormal = new THREE.Vector3(1, 0, 0);
  const binormal = new THREE.Vector3();
  const frameN = new THREE.Vector3();
  let dist = 0;

  for (let r = 0; r < rings; r++) {
    const p = points[r];
    if (r > 0) dist += p.distanceTo(points[r - 1]);

    if (r === 0) tangent.subVectors(points[1], points[0]).normalize();
    else if (r === rings - 1) tangent.subVectors(points[r], points[r - 1]).normalize();
    else tangent.subVectors(points[r + 1], points[r - 1]).normalize();

    if (r === 0) {
      const ref = Math.abs(tangent.y) < 0.92 ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(1, 0, 0);
      prevNormal.crossVectors(ref, tangent).normalize();
    } else {
      // Parallel-transport frame to prevent twisting along curved trunks/limbs.
      prevNormal.addScaledVector(tangent, -prevNormal.dot(tangent));
      if (prevNormal.lengthSq() < 1e-6) prevNormal.set(1, 0, 0);
      prevNormal.normalize();
    }
    binormal.crossVectors(tangent, prevNormal).normalize();

    const rad = radii[r];
    const t = r / Math.max(1, rings - 1);
    const ao = lerp(baseAo, tipAo, Math.pow(t, 0.7));

    for (let s = 0; s < cols; s++) {
      const u = s / radialSegs;
      const ang = u * Math.PI * 2;
      const ca = Math.cos(ang);
      const sa = Math.sin(ang);
      // Subtle organic bark fluting near the root buttress.
      const flute = r <= 1 ? 1 + 0.12 * Math.sin(ang * 5) * (1 - r * 0.5) : 1;
      frameN.set(
        prevNormal.x * ca + binormal.x * sa,
        prevNormal.y * ca + binormal.y * sa,
        prevNormal.z * ca + binormal.z * sa,
      ).normalize();

      const vi = r * cols + s;
      positions[vi * 3] = p.x + frameN.x * rad * flute;
      positions[vi * 3 + 1] = p.y + frameN.y * rad * flute;
      positions[vi * 3 + 2] = p.z + frameN.z * rad * flute;

      normals[vi * 3] = frameN.x;
      normals[vi * 3 + 1] = frameN.y;
      normals[vi * 3 + 2] = frameN.z;

      uvs[vi * 2] = u;
      uvs[vi * 2 + 1] = dist * uvTileV;

      colors[vi * 3] = ao;
      colors[vi * 3 + 1] = ao * 0.98;
      colors[vi * 3 + 2] = ao * 0.95;
    }
  }

  for (let r = 0; r < rings - 1; r++) {
    for (let s = 0; s < radialSegs; s++) {
      const a = r * cols + s;
      const b = a + 1;
      const c = (r + 1) * cols + s;
      const d = c + 1;
      indices.push(a, b, c, b, d, c);
    }
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geo.setAttribute('normal', new THREE.BufferAttribute(normals, 3));
  geo.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
  geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  geo.setIndex(indices);
  return geo;
}

/**
 * Builds a curved foliage frond/card (default 1x2 = 4 tris, or 1x1 = 2 tris) so botanical leaves
 * & boughs read as arched volumetric 3D forms at half the vertex cost of 2x2 cards.
 */
function buildCurvedCard(
  width: number,
  length: number,
  archY: number,
  droopY: number,
  cupY: number,
  pivotAtBase: boolean,
  segX = 1,
  segZ = 2,
): THREE.BufferGeometry {
  const cols = segX + 1;
  const rows = segZ + 1;
  const positions = new Float32Array(cols * rows * 3);
  const uvs = new Float32Array(cols * rows * 2);
  const indices: number[] = [];

  for (let iz = 0; iz < rows; iz++) {
    const v = iz / segZ; // 0 = base stem, 1 = outer tip
    const z = pivotAtBase ? v * length : (v - 0.5) * length;
    const arch = Math.sin(v * Math.PI) * archY - v * v * droopY;
    for (let ix = 0; ix < cols; ix++) {
      const u = ix / segX;
      const nx = u * 2 - 1;
      const x = nx * width * 0.5;
      const y = arch - (segX >= 2 ? nx * nx * cupY : 0);
      const vi = iz * cols + ix;
      positions[vi * 3] = x;
      positions[vi * 3 + 1] = y;
      positions[vi * 3 + 2] = z;
      uvs[vi * 2] = u;
      uvs[vi * 2 + 1] = v;
    }
  }

  for (let iz = 0; iz < segZ; iz++) {
    for (let ix = 0; ix < segX; ix++) {
      const a = iz * cols + ix;
      const b = a + 1;
      const c = (iz + 1) * cols + ix;
      const d = c + 1;
      indices.push(a, c, b, b, c, d);
    }
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geo.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
  geo.setIndex(indices);
  geo.computeVertexNormals();
  return geo;
}

/**
 * Coastal Pine / California Conifer:
 * - Crooked tapered bark trunk with flared root collar + upper woody bough stubs
 * - 7 staggered whorls of arched 3D pine-bough fronds + vertical infill sprays
 * - Outward-upward ellipsoidal botanical vertex normals + interior canopy AO vertex colors
 */
function buildCoastalPineGeometries(): { trunk: THREE.BufferGeometry; canopy: THREE.BufferGeometry } {
  const rand = seededRandom(5101);

  // 1. Crooked tapered trunk + protruding woody limb stubs
  const trunkPts = [
    new THREE.Vector3(0.0, -0.75, 0.0),
    new THREE.Vector3(0.0, 0.35, 0.0),
    new THREE.Vector3(0.09, 3.4, 0.02),
    new THREE.Vector3(0.04, 7.1, 0.07),
    new THREE.Vector3(0.0, 11.2, 0.0),
  ];
  const trunkRadii = [0.46, 0.33, 0.23, 0.14, 0.035];
  const trunkParts: THREE.BufferGeometry[] = [buildTaperedBranchTube(trunkPts, trunkRadii, 6, 0.65, 0.56, 0.92)];

  const stubHeights = [3.1, 4.3, 5.6, 6.9];
  for (let i = 0; i < stubHeights.length; i++) {
    const h = stubHeights[i];
    const ang = i * 2.39996 + 0.4;
    const len = lerp(1.3, 0.72, i / stubHeights.length);
    const dirX = Math.cos(ang);
    const dirZ = Math.sin(ang);
    const pts = [
      new THREE.Vector3(0, h, 0),
      new THREE.Vector3(dirX * len, h - 0.04, dirZ * len),
    ];
    trunkParts.push(buildTaperedBranchTube(pts, [0.09, 0.03], 4, 0.8, 0.52, 0.78));
  }
  const trunk = mergeColoredParts(trunkParts);

  // 2. Multi-whorl 3D curved pine boughs (ZERO cones!)
  const canopyParts: THREE.BufferGeometry[] = [];
  const tiers: readonly { y: number; count: number; len: number; wid: number; pitch: number; droop: number; yawOff: number }[] = [
    { y: 2.80, count: 5, len: 3.20, wid: 2.55, pitch: 0.24, droop: 0.45, yawOff: 0.1 },
    { y: 4.15, count: 5, len: 2.95, wid: 2.38, pitch: 0.18, droop: 0.36, yawOff: 0.72 },
    { y: 5.50, count: 4, len: 2.65, wid: 2.18, pitch: 0.11, droop: 0.28, yawOff: 0.38 },
    { y: 6.80, count: 4, len: 2.28, wid: 1.92, pitch: 0.02, droop: 0.22, yawOff: 1.04 },
    { y: 8.05, count: 4, len: 1.86, wid: 1.64, pitch: -0.10, droop: 0.16, yawOff: 0.55 },
    { y: 9.25, count: 4, len: 1.44, wid: 1.32, pitch: -0.28, droop: 0.10, yawOff: 1.25 },
    { y: 10.35, count: 3, len: 1.28, wid: 1.02, pitch: -0.76, droop: 0.06, yawOff: 0.85 },
  ];

  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const e = new THREE.Euler();
  const p = new THREE.Vector3();
  const sc = new THREE.Vector3(1, 1, 1);

  for (let ti = 0; ti < tiers.length; ti++) {
    const tier = tiers[ti];
    for (let k = 0; k < tier.count; k++) {
      const yaw = tier.yawOff + (k / tier.count) * Math.PI * 2 + (rand() - 0.5) * 0.24;
      const lenJitter = tier.len * (0.88 + rand() * 0.24);
      const widJitter = tier.wid * (0.90 + rand() * 0.20);
      const card = buildCurvedCard(widJitter, lenJitter, 0.24, tier.droop, 0.0, true, 1, 2);
      const roll = (rand() - 0.5) * 0.28;
      e.set(tier.pitch + (rand() - 0.5) * 0.09, yaw, roll, 'YXZ');
      q.setFromEuler(e);
      p.set(Math.sin(yaw) * 0.08, tier.y + (rand() - 0.5) * 0.25, Math.cos(yaw) * 0.08);
      m.compose(p, q, sc);
      card.applyMatrix4(m);
      canopyParts.push(card);

      // Tilted cross-boughs across lower/mid/upper tiers so silhouettes stay lush & volumetric.
      if (ti < 5 && k % 2 === 0) {
        const crossCard = buildCurvedCard(widJitter * 0.88, lenJitter * 0.90, 0.16, tier.droop * 0.55, 0.0, true, 1, 2);
        e.set(tier.pitch - 0.18, yaw + 0.34, (k % 4 === 0 ? 1 : -1) * 0.72, 'YXZ');
        q.setFromEuler(e);
        p.set(Math.sin(yaw + 0.34) * 0.12, tier.y + 0.32, Math.cos(yaw + 0.34) * 0.12);
        m.compose(p, q, sc);
        crossCard.applyMatrix4(m);
        canopyParts.push(crossCard);
      }
    }
  }

  const canopy = mergeColoredParts(canopyParts);

  const posAttr = canopy.attributes.position as THREE.BufferAttribute;
  const normAttr = canopy.attributes.normal as THREE.BufferAttribute;
  const colAttr = canopy.attributes.color as THREE.BufferAttribute;
  const v = new THREE.Vector3();
  const n = new THREE.Vector3();

  for (let i = 0; i < posAttr.count; i++) {
    v.fromBufferAttribute(posAttr, i);
    const horiz = Math.hypot(v.x, v.z);
    const heightT = clamp((v.y - 2.3) / 9.2, 0, 1);
    const expectedRad = lerp(2.9, 0.5, heightT);
    const radialT = clamp(horiz / Math.max(0.5, expectedRad), 0, 1);

    n.set(v.x, (v.y - 6.1) * 0.55 + 1.55, v.z).normalize();
    normAttr.setXYZ(i, n.x, n.y, n.z);

    const ao = lerp(0.58, 1.05, clamp(radialT * 0.62 + heightT * 0.52, 0, 1));
    colAttr.setXYZ(i, ao * lerp(0.88, 1.04, heightT), ao * lerp(0.95, 1.01, heightT), ao * lerp(0.88, 0.93, heightT));
  }
  normAttr.needsUpdate = true;
  colAttr.needsUpdate = true;

  return { trunk, canopy };
}

/**
 * California Live Oak / Broadleaf Tree:
 * - Gnarled flared trunk forking into 4 spreading primary boughs & 4 secondary branches
 * - 21 cupped broadleaf cluster cards arranged in 5 asymmetric natural canopy lobes (ZERO spheres!)
 * - Blended spherical-lobe outward normals + deep interior canopy AO vertex colors
 */
function buildCaliforniaOakGeometries(): { trunk: THREE.BufferGeometry; canopy: THREE.BufferGeometry } {
  const rand = seededRandom(5209);

  // 1. Multi-forked oak trunk & spreading boughs
  const mainTrunk = [
    new THREE.Vector3(0, -0.75, 0),
    new THREE.Vector3(0.02, 0.35, 0.01),
    new THREE.Vector3(0.08, 1.35, -0.05),
    new THREE.Vector3(0.04, 2.35, 0.02),
  ];
  const trunkParts: THREE.BufferGeometry[] = [
    buildTaperedBranchTube(mainTrunk, [0.54, 0.39, 0.33, 0.29], 6, 0.55, 0.52, 0.85),
  ];

  const limbs: readonly { dx: number; dz: number; midY: number; tipY: number; reach: number; r0: number }[] = [
    { dx: 0.92, dz: 0.38, midY: 3.45, tipY: 4.85, reach: 2.35, r0: 0.21 },
    { dx: -0.84, dz: 0.54, midY: 3.60, tipY: 5.05, reach: 2.25, r0: 0.20 },
    { dx: -0.58, dz: -0.81, midY: 3.35, tipY: 4.75, reach: 2.20, r0: 0.19 },
    { dx: 0.66, dz: -0.75, midY: 3.55, tipY: 5.15, reach: 2.30, r0: 0.20 },
  ];

  const lobeCenters: { c: THREE.Vector3; rad: number }[] = [
    { c: new THREE.Vector3(0.0, 6.25, 0.0), rad: 2.35 },
  ];

  for (let i = 0; i < limbs.length; i++) {
    const l = limbs[i];
    const start = new THREE.Vector3(0.04, 2.15, 0.02);
    const mid = new THREE.Vector3(l.dx * l.reach * 0.52, l.midY, l.dz * l.reach * 0.52);
    const tip = new THREE.Vector3(l.dx * l.reach, l.tipY, l.dz * l.reach);
    trunkParts.push(buildTaperedBranchTube([start, mid, tip], [l.r0, l.r0 * 0.65, 0.06], 5, 0.65, 0.56, 0.82));

    const subTip = new THREE.Vector3(
      l.dx * l.reach * 0.72 + (rand() - 0.5) * 0.6,
      l.tipY + 0.95,
      l.dz * l.reach * 0.72 + (rand() - 0.5) * 0.6,
    );
    trunkParts.push(buildTaperedBranchTube([mid, subTip], [l.r0 * 0.55, 0.05], 4, 0.7, 0.55, 0.80));

    lobeCenters.push({ c: new THREE.Vector3(tip.x * 0.92, tip.y + 0.35, tip.z * 0.92), rad: 1.95 });
  }
  const trunk = mergeColoredParts(trunkParts);

  // 2. Asymmetric multi-cluster oak foliage cards around the 5 lobes
  const canopyParts: THREE.BufferGeometry[] = [];
  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const e = new THREE.Euler();
  const pos = new THREE.Vector3();
  const sc = new THREE.Vector3(1, 1, 1);

  for (let li = 0; li < lobeCenters.length; li++) {
    const lobe = lobeCenters[li];
    const cardCount = li === 0 ? 5 : 4;
    for (let k = 0; k < cardCount; k++) {
      const az = (k / cardCount) * Math.PI * 2 + li * 0.8 + (rand() - 0.5) * 0.35;
      const elev = (k === 0 ? 0.55 : -0.1 + rand() * 0.55);
      const dist = lobe.rad * (k === 0 ? 0.22 : 0.42 + rand() * 0.34);
      const size = (li === 0 ? 2.85 : 2.52) * (0.86 + rand() * 0.26);

      const card = buildCurvedCard(size, size * (0.9 + rand() * 0.2), 0.22, 0.14, 0.24, false, 1, 2);

      pos.set(
        lobe.c.x + Math.cos(az) * Math.cos(elev) * dist,
        lobe.c.y + Math.sin(elev) * dist * 0.75,
        lobe.c.z + Math.sin(az) * Math.cos(elev) * dist,
      );

      const pitch = k === 0 ? (rand() - 0.5) * 0.3 : 0.45 + rand() * 0.85;
      const roll = (rand() - 0.5) * 0.55;
      e.set(pitch, az + Math.PI * 0.5, roll, 'YXZ');
      q.setFromEuler(e);
      m.compose(pos, q, sc);
      card.applyMatrix4(m);
      canopyParts.push(card);
    }
  }

  const canopy = mergeColoredParts(canopyParts);

  const posAttr = canopy.attributes.position as THREE.BufferAttribute;
  const normAttr = canopy.attributes.normal as THREE.BufferAttribute;
  const colAttr = canopy.attributes.color as THREE.BufferAttribute;
  const crownCenter = new THREE.Vector3(0, 5.1, 0);
  const v = new THREE.Vector3();
  const nTree = new THREE.Vector3();
  const nLobe = new THREE.Vector3();

  for (let i = 0; i < posAttr.count; i++) {
    v.fromBufferAttribute(posAttr, i);

    let nearest = lobeCenters[0];
    let bestD2 = Infinity;
    for (const lc of lobeCenters) {
      const d2 = v.distanceToSquared(lc.c);
      if (d2 < bestD2) {
        bestD2 = d2;
        nearest = lc;
      }
    }

    nTree.subVectors(v, crownCenter);
    nTree.y += 1.05;
    nTree.normalize();

    nLobe.subVectors(v, nearest.c);
    nLobe.y += 0.55;
    nLobe.normalize();

    nTree.lerp(nLobe, 0.45).normalize();
    normAttr.setXYZ(i, nTree.x, nTree.y, nTree.z);

    const distFromCore = v.distanceTo(crownCenter);
    const heightT = clamp((v.y - 3.3) / 4.3, 0, 1);
    const radialT = clamp((distFromCore - 0.8) / 3.0, 0, 1);
    const ao = lerp(0.56, 1.06, clamp(radialT * 0.58 + heightT * 0.58, 0, 1));
    colAttr.setXYZ(i, ao * lerp(0.88, 1.05, heightT), ao * lerp(0.95, 1.02, heightT), ao * lerp(0.86, 0.91, heightT));
  }
  normAttr.needsUpdate = true;
  colAttr.needsUpdate = true;

  return { trunk, canopy };
}

/**
 * 3-plane star-crossed curved coastal wild grass tuft with soft upward normals and grounded root AO.
 */
function buildGrassTuftGeometry(): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  const angles = [0, Math.PI / 3, (Math.PI * 2) / 3];
  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const e = new THREE.Euler();
  const p = new THREE.Vector3();
  const sc = new THREE.Vector3(1, 1, 1);

  for (let i = 0; i < angles.length; i++) {
    const w = 1.32;
    const h = 0.86;
    const g = new THREE.PlaneGeometry(w, h, 1, 2);
    const pos = g.attributes.position as THREE.BufferAttribute;
    const col = new Float32Array(pos.count * 3);
    for (let vi = 0; vi < pos.count; vi++) {
      const px = pos.getX(vi);
      const py = pos.getY(vi) + h * 0.5 - 0.06;
      const t = clamp((py + 0.06) / h, 0, 1);
      const bowZ = t * t * 0.18 * (i % 2 === 0 ? 1 : -1);
      const flareX = px * (1 + t * 0.24);
      pos.setXYZ(vi, flareX, py, bowZ);

      const ao = lerp(0.62, 1.04, Math.pow(t, 0.7));
      col[vi * 3] = ao * 1.02;
      col[vi * 3 + 1] = ao * 1.0;
      col[vi * 3 + 2] = ao * 0.92;
    }
    g.setAttribute('color', new THREE.BufferAttribute(col, 3));

    e.set(0, angles[i], 0);
    q.setFromEuler(e);
    m.compose(p, q, sc);
    g.applyMatrix4(m);
    parts.push(g);
  }

  const merged = mergeColoredParts(parts);
  const posAttr = merged.attributes.position as THREE.BufferAttribute;
  const normAttr = merged.attributes.normal as THREE.BufferAttribute;
  const n = new THREE.Vector3();
  for (let i = 0; i < posAttr.count; i++) {
    n.set(posAttr.getX(i) * 0.35, 0.92, posAttr.getZ(i) * 0.35).normalize();
    normAttr.setXYZ(i, n.x, n.y, n.z);
  }
  normAttr.needsUpdate = true;
  return merged;
}

/**
 * Low California sagebrush / chaparral bush built from 6 angled leaf-cluster cards (12 tris total).
 */
function buildChaparralShrubGeometry(): THREE.BufferGeometry {
  const rand = seededRandom(5317);
  const parts: THREE.BufferGeometry[] = [];
  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const e = new THREE.Euler();
  const p = new THREE.Vector3();
  const sc = new THREE.Vector3(1, 1, 1);

  for (let i = 0; i < 6; i++) {
    const az = (i / 6) * Math.PI * 2 + (rand() - 0.5) * 0.35;
    const r = i < 2 ? 0.18 : 0.42 + rand() * 0.24;
    const size = i < 2 ? 1.42 : 1.18 + rand() * 0.26;
    const card = buildCurvedCard(size, size * 0.92, 0.14, 0.10, 0.18, false, 1, 1);
    const pitch = i < 2 ? 0.22 : 0.65 + rand() * 0.45;
    e.set(pitch, az + Math.PI * 0.5, (rand() - 0.5) * 0.4, 'YXZ');
    q.setFromEuler(e);
    p.set(Math.cos(az) * r, i < 2 ? 0.68 : 0.42 + rand() * 0.22, Math.sin(az) * r);
    m.compose(p, q, sc);
    card.applyMatrix4(m);
    parts.push(card);
  }

  const merged = mergeColoredParts(parts);
  const posAttr = merged.attributes.position as THREE.BufferAttribute;
  const normAttr = merged.attributes.normal as THREE.BufferAttribute;
  const colAttr = merged.attributes.color as THREE.BufferAttribute;
  const n = new THREE.Vector3();

  for (let i = 0; i < posAttr.count; i++) {
    const x = posAttr.getX(i);
    const y = posAttr.getY(i);
    const z = posAttr.getZ(i);
    n.set(x, Math.max(0.25, y) + 0.55, z).normalize();
    normAttr.setXYZ(i, n.x, n.y, n.z);

    const hT = clamp((y + 0.05) / 1.05, 0, 1);
    const ao = lerp(0.60, 1.04, hT);
    colAttr.setXYZ(i, ao, ao, ao * 0.96);
  }
  normAttr.needsUpdate = true;
  colAttr.needsUpdate = true;
  return merged;
}

/**
 * Noise-sculpted stratified California sandstone / granite boulder with triplanar UVs & crevice AO.
 */
function buildSculptedBoulderGeometry(seed: number, angularity: number): THREE.BufferGeometry {
  const rand = seededRandom(seed);
  const base = new THREE.IcosahedronGeometry(1.0, 2);
  const pos = base.attributes.position as THREE.BufferAttribute;

  // Deterministic random rock cleavage planes & strata phase
  const planes: { nx: number; ny: number; nz: number; cut: number }[] = [];
  for (let i = 0; i < 6; i++) {
    const v = new THREE.Vector3(rand() * 2 - 1, rand() * 1.4 - 0.4, rand() * 2 - 1).normalize();
    planes.push({ nx: v.x, ny: v.y, nz: v.z, cut: 0.62 + rand() * 0.34 });
  }
  const p1 = rand() * 10;
  const p2 = rand() * 10;
  const p3 = rand() * 10;

  const displaced = new Float32Array(pos.count);
  for (let i = 0; i < pos.count; i++) {
    let x = pos.getX(i);
    let y = pos.getY(i);
    let z = pos.getZ(i);

    // Multi-frequency rocky lumps + sedimentary horizontal ledges
    const n1 = Math.sin(x * 2.4 + p1) * Math.cos(z * 2.2 + p2) * Math.sin(y * 2.6 + p3);
    const n2 = Math.sin(x * 5.3 - z * 4.1 + p2) * Math.cos(y * 5.8 + p1) * 0.45;
    const strata = Math.sin(y * 7.5 + n1 * 1.4) * 0.085;
    let r = 1.0 + n1 * 0.22 + n2 * 0.10 + strata;

    // Flatten natural rock fracture cleavage planes
    for (const pl of planes) {
      const proj = x * pl.nx + y * pl.ny + z * pl.nz;
      if (proj > pl.cut) {
        r -= (proj - pl.cut) * angularity;
      }
    }

    x *= r;
    y *= r;
    z *= r;
    // Grounded broad underside so boulders nestle organically into hillsides
    if (y < -0.35) y = -0.35 + (y + 0.35) * 0.36;

    pos.setXYZ(i, x, y, z);
    displaced[i] = r;
  }

  // Ensure non-indexed geometry for crisp triplanar UV mapping + partial flat/smooth rock shading
  const geo = base.index ? base.toNonIndexed() : base;
  if (base.index) base.dispose();
  geo.computeVertexNormals();

  const gPos = geo.attributes.position as THREE.BufferAttribute;
  const gNorm = geo.attributes.normal as THREE.BufferAttribute;
  const uvs = new Float32Array(gPos.count * 2);
  const cols = new Float32Array(gPos.count * 3);

  for (let i = 0; i < gPos.count; i++) {
    const x = gPos.getX(i);
    const y = gPos.getY(i);
    const z = gPos.getZ(i);
    const ax = Math.abs(gNorm.getX(i));
    const ay = Math.abs(gNorm.getY(i));
    const az = Math.abs(gNorm.getZ(i));

    if (ay >= ax && ay >= az) {
      uvs[i * 2] = x * 0.55;
      uvs[i * 2 + 1] = z * 0.55;
    } else if (ax >= az) {
      uvs[i * 2] = z * 0.55;
      uvs[i * 2 + 1] = y * 0.55;
    } else {
      uvs[i * 2] = x * 0.55;
      uvs[i * 2 + 1] = y * 0.55;
    }

    // Subtle sunlit top vs shadowed grounded underside + stratified band tint
    const topT = clamp((y + 0.55) / 1.45, 0, 1);
    const strataBand = Math.sin(y * 8.5 + x * 1.2) * 0.05;
    const shade = clamp(lerp(0.58, 1.02, topT) + strataBand, 0.45, 1.08);
    cols[i * 3] = shade * 1.02;
    cols[i * 3 + 1] = shade * 0.99;
    cols[i * 3 + 2] = shade * 0.94;
  }

  geo.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
  geo.setAttribute('color', new THREE.BufferAttribute(cols, 3));
  return geo;
}

/**
 * Extruded highway W-beam corrugated guardrail section (1.0m unit length along Z: -0.5..+0.5).
 */
function buildWBeamGuardrailGeometry(): THREE.BufferGeometry {
  // Double-wave corrugated W-beam cross section (X thickness, Y height ~0.34m)
  const front: readonly [number, number][] = [
    [-0.036, 0.17],
    [0.048, 0.14],
    [0.048, 0.058],
    [-0.028, 0.0],
    [0.048, -0.058],
    [0.048, -0.14],
    [-0.036, -0.17],
  ];
  const thick = 0.024;
  // Closed loop: front top->bottom, then back bottom->top
  const ring: [number, number][] = [...front];
  for (let i = front.length - 1; i >= 0; i--) {
    ring.push([front[i][0] - thick, front[i][1]]);
  }

  const n = ring.length;
  const positions: number[] = [];
  const uvs: number[] = [];
  const indices: number[] = [];

  for (let i = 0; i < n; i++) {
    const a = ring[i];
    const b = ring[(i + 1) % n];
    const vA = clamp(0.5 - a[1] / 0.34, 0, 1);
    const vB = clamp(0.5 - b[1] / 0.34, 0, 1);
    const base = positions.length / 3;
    positions.push(
      a[0], a[1], -0.5,
      a[0], a[1], 0.5,
      b[0], b[1], -0.5,
      b[0], b[1], 0.5,
    );
    uvs.push(
      0, vA,
      2, vA,
      0, vB,
      2, vB,
    );
    indices.push(base, base + 1, base + 2, base + 1, base + 3, base + 2);
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(positions), 3));
  geo.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(uvs), 2));
  geo.setIndex(indices);
  geo.computeVertexNormals();
  return geo;
}

/**
 * Guardrail vertical steel post with top offset spacer blockout holding the W-beam (24 tris).
 */
function buildGuardrailPostGeometry(): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  const postH = 1.08;
  const stem = new THREE.BoxGeometry(0.11, postH, 0.10);
  stem.translate(0, 0.30, 0);
  const blockout = new THREE.BoxGeometry(0.16, 0.34, 0.12);
  blockout.translate(0.0, 0.62, 0);

  parts.push(tintGeometry(stem, 0x848c95), tintGeometry(blockout, 0x4b5158));
  return mergeColoredParts(parts);
}

/**
 * Extruded New Jersey Type-F beveled concrete barrier along Z (`length`), standing on y = 0.
 */
function buildJerseyBarrierGeometry(length: number, height = 1.08, baseWidth = 0.88): THREE.BufferGeometry {
  const hw = baseWidth * 0.5;
  const kneeX = hw * 0.54;
  const topX = hw * 0.30;
  const profile: readonly [number, number][] = [
    [-hw, 0],
    [hw, 0],
    [hw, 0.10],
    [kneeX, 0.34],
    [topX, height],
    [-topX, height],
    [-kneeX, 0.34],
    [-hw, 0.10],
  ];

  const halfL = length * 0.5;
  const positions: number[] = [];
  const uvs: number[] = [];
  const indices: number[] = [];

  const pushQuad = (
    ax: number, ay: number, az: number, au: number, av: number,
    bx: number, by: number, bz: number, bu: number, bv: number,
    cx: number, cy: number, cz: number, cu: number, cv: number,
    dx: number, dy: number, dz: number, du: number, dv: number,
  ) => {
    const base = positions.length / 3;
    positions.push(ax, ay, az, bx, by, bz, cx, cy, cz, dx, dy, dz);
    uvs.push(au, av, bu, bv, cu, cv, du, dv);
    indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
  };

  for (let i = 0; i < profile.length; i++) {
    const a = profile[i];
    const b = profile[(i + 1) % profile.length];
    pushQuad(
      a[0], a[1], -halfL, 0, a[1] / 2,
      b[0], b[1], -halfL, 0, b[1] / 2,
      b[0], b[1], halfL, length / 2.4, b[1] / 2,
      a[0], a[1], halfL, length / 2.4, a[1] / 2,
    );
  }

  // Front (+Z) and Back (-Z) fan caps
  const capStart = positions.length / 3;
  for (const [px, py] of profile) {
    positions.push(px, py, halfL);
    uvs.push(px * 0.5, py * 0.5);
  }
  for (let i = 1; i < profile.length - 1; i++) {
    indices.push(capStart, capStart + i, capStart + i + 1);
  }

  const backStart = positions.length / 3;
  for (const [px, py] of profile) {
    positions.push(px, py, -halfL);
    uvs.push(px * 0.5, py * 0.5);
  }
  for (let i = 1; i < profile.length - 1; i++) {
    indices.push(backStart, backStart + i + 1, backStart + i);
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(positions), 3));
  geo.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(uvs), 2));
  geo.setIndex(indices);
  geo.computeVertexNormals();
  return geo;
}

/**
 * Tapered galvanized highway cobra-head streetlamp (concrete plinth + tapered pole + curved mast arm + housing)
 * plus matching warm lens geometry.
 */
function buildCobraStreetlampGeometries(): { structure: THREE.BufferGeometry; lens: THREE.BufferGeometry } {
  const parts: THREE.BufferGeometry[] = [];

  const plinth = new THREE.CylinderGeometry(0.24, 0.28, 1.0, 6);
  plinth.translate(0, 0.15, 0);
  parts.push(tintGeometry(plinth, 0x9b9890));

  const flange = new THREE.CylinderGeometry(0.18, 0.21, 0.08, 6);
  flange.translate(0, 0.69, 0);
  parts.push(tintGeometry(flange, 0x707882));

  const shaft = new THREE.CylinderGeometry(0.072, 0.135, 6.85, 6);
  shaft.translate(0, 4.14, 0);
  parts.push(tintGeometry(shaft, 0xb2bac2));

  const armPts = [
    new THREE.Vector3(0, 7.25, 0.0),
    new THREE.Vector3(0, 7.72, 0.55),
    new THREE.Vector3(0, 8.00, 1.35),
    new THREE.Vector3(0, 7.98, 2.15),
  ];
  const arm = buildTaperedBranchTube(armPts, [0.064, 0.054, 0.046, 0.040], 5, 0.5, 0.84, 0.92);
  parts.push(tintGeometry(arm, 0xaab2ba));

  const neck = new THREE.BoxGeometry(0.20, 0.12, 0.38);
  neck.translate(0, 7.97, 2.24);
  const head = new THREE.CylinderGeometry(0.20, 0.26, 0.14, 6);
  head.scale(0.88, 1.0, 1.75);
  head.translate(0, 7.98, 2.60);
  parts.push(tintGeometry(neck, 0x5c646e), tintGeometry(head, 0x67707b));

  const structure = mergeColoredParts(parts);

  const lens = new THREE.BoxGeometry(0.32, 0.06, 0.58);
  lens.translate(0, 7.89, 2.62);

  return { structure, lens };
}

/**
 * Multi-tone realistic safety traffic cone with weighted dark rubber base + twin white reflective collars.
 */
function buildTrafficConeGeometry(): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];

  const base = new THREE.BoxGeometry(0.42, 0.055, 0.42);
  base.translate(0, 0.0275, 0);
  parts.push(tintGeometry(base, 0x22252a));

  const segs: readonly [y0: number, y1: number, r0: number, r1: number, hex: number][] = [
    [0.05, 0.43, 0.165, 0.105, 0xf96316],
    [0.43, 0.52, 0.105, 0.091, 0xf4f6f8],
    [0.52, 0.59, 0.091, 0.080, 0xf96316],
    [0.59, 0.68, 0.080, 0.066, 0xf4f6f8],
    [0.68, 0.78, 0.066, 0.044, 0xf96316],
  ];
  for (const [y0, y1, r0, r1, hex] of segs) {
    const g = new THREE.CylinderGeometry(r1, r0, y1 - y0, 7, 1, y0 > 0.05 && y1 < 0.78);
    g.translate(0, (y0 + y1) * 0.5, 0);
    parts.push(tintGeometry(g, hex));
  }

  return mergeColoredParts(parts);
}

/**
 * Slender white roadside highway delineator post with amber retroreflective band.
 */
function buildDelineatorPostGeometry(): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  const foot = new THREE.BoxGeometry(0.11, 0.44, 0.055);
  foot.translate(0, -0.13, 0);
  const body = new THREE.BoxGeometry(0.085, 0.72, 0.036);
  body.translate(0, 0.44, 0);
  const band = new THREE.BoxGeometry(0.09, 0.17, 0.042);
  band.translate(0, 0.88, 0);
  const cap = new THREE.BoxGeometry(0.085, 0.08, 0.036);
  cap.translate(0, 1.0, 0);
  parts.push(
    tintGeometry(foot, 0x2a2d33),
    tintGeometry(body, 0xeaeef2),
    tintGeometry(band, 0xf5a614),
    tintGeometry(cap, 0xeaeef2),
  );
  return mergeColoredParts(parts);
}

/**
 * Builds a watertight extruded ramp or speed-bump mesh along X (extruded across Z)
 * and simultaneously returns an exact TrimeshColliderDef from the same vertices & indices.
 */
function buildProfilePrism(
  profile: readonly [x: number, y: number][],
  centerZ: number,
  widthZ: number,
  id: string,
  tag: string,
  surface: 'concrete' | 'asphalt',
): { geometry: THREE.BufferGeometry; collider: TrimeshColliderDef } {
  const z0 = centerZ - widthZ * 0.5;
  const z1 = centerZ + widthZ * 0.5;
  const positions: number[] = [];
  const uvs: number[] = [];
  const indices: number[] = [];

  const pushTri = (
    ax: number, ay: number, az: number, au: number, av: number,
    bx: number, by: number, bz: number, bu: number, bv: number,
    cx: number, cy: number, cz: number, cu: number, cv: number,
  ) => {
    const base = positions.length / 3;
    positions.push(ax, ay, az, bx, by, bz, cx, cy, cz);
    uvs.push(au, av, bu, bv, cu, cv);
    indices.push(base, base + 1, base + 2);
  };

  let runLen = 0;
  for (let i = 0; i < profile.length - 1; i++) {
    const [x0, y0] = profile[i];
    const [x1, y1] = profile[i + 1];
    const segLen = Math.hypot(x1 - x0, y1 - y0);
    const v0 = runLen / 4;
    const v1 = (runLen + segLen) / 4;
    runLen += segLen;

    // Top driveable face (CCW outward normal: +Y / -X facing approach).
    pushTri(x0, y0, z0, 0, v0, x0, y0, z1, widthZ / 4, v0, x1, y1, z0, 0, v1);
    pushTri(x1, y1, z0, 0, v1, x0, y0, z1, widthZ / 4, v0, x1, y1, z1, widthZ / 4, v1);

    // Side wall at z0 (-Z outward).
    if (y0 > 0.001 || y1 > 0.001) {
      pushTri(x0, 0, z0, x0 / 4, 0, x0, y0, z0, x0 / 4, y0 / 4, x1, 0, z0, x1 / 4, 0);
      pushTri(x1, 0, z0, x1 / 4, 0, x0, y0, z0, x0 / 4, y0 / 4, x1, y1, z0, x1 / 4, y1 / 4);

      // Side wall at z1 (+Z outward).
      pushTri(x0, 0, z1, x0 / 4, 0, x1, 0, z1, x1 / 4, 0, x0, y0, z1, x0 / 4, y0 / 4);
      pushTri(x1, 0, z1, x1 / 4, 0, x1, y1, z1, x1 / 4, y1 / 4, x0, y0, z1, x0 / 4, y0 / 4);
    }
  }

  const [xStart, yStart] = profile[0];
  if (yStart > 0.005) {
    pushTri(xStart, 0, z0, 0, 0, xStart, 0, z1, widthZ / 4, 0, xStart, yStart, z0, 0, yStart / 4);
    pushTri(xStart, 0, z1, widthZ / 4, 0, xStart, yStart, z1, widthZ / 4, yStart / 4, xStart, yStart, z0, 0, yStart / 4);
  }
  const [xEnd, yEnd] = profile[profile.length - 1];
  if (yEnd > 0.005) {
    pushTri(xEnd, 0, z0, 0, 0, xEnd, yEnd, z0, 0, yEnd / 4, xEnd, 0, z1, widthZ / 4, 0);
    pushTri(xEnd, 0, z1, widthZ / 4, 0, xEnd, yEnd, z0, 0, yEnd / 4, xEnd, yEnd, z1, widthZ / 4, yEnd / 4);
  }

  const vertices = new Float32Array(positions);
  const indexArray = new Uint32Array(indices);
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(vertices, 3));
  geometry.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(uvs), 2));
  geometry.setIndex(new THREE.BufferAttribute(indexArray, 1));
  geometry.computeVertexNormals();

  const collider: TrimeshColliderDef = {
    type: 'trimesh',
    id,
    tag,
    surface,
    friction: 0.9,
    restitution: 0.05,
    vertices: new Float32Array(vertices),
    indices: new Uint32Array(indexArray),
  };

  return { geometry, collider };
}

/** Adds a structural vertical steel I-beam column (flanges + web + concrete plinth base) into `batcher`. */
function addIBeamColumn(
  batcher: MeshBatcher,
  steelMat: THREE.Material,
  concreteMat: THREE.Material,
  x: number,
  yBase: number,
  z: number,
  height: number,
  size = 0.44,
  plinthHeight = 0.42,
): void {
  if (plinthHeight > 0) {
    batcher.slab(concreteMat, size + 0.24, plinthHeight, size + 0.24, x, yBase, z);
  }
  const colY = yBase + plinthHeight;
  const colH = Math.max(0.2, height - plinthHeight);
  const flangeT = size * 0.18;
  const webT = size * 0.16;
  batcher.slab(steelMat, size, colH, flangeT, x, colY, z - size * 0.41);
  batcher.slab(steelMat, size, colH, flangeT, x, colY, z + size * 0.41);
  batcher.slab(steelMat, webT, colH, size * 0.82, x, colY, z);
}

/**
 * Builds all roadside buildings, Blend Garage HQ Exterior, Crash-Test & Stunt Proving Grounds,
 * steel-truss highway overhead gantries, realistic multi-part instanced conifers/oaks/grass/shrubs,
 * sculpted canyon boulders, W-beam guardrails, cobra-head streetlamps, chevrons & cones,
 * and returns their exact matching physics colliders.
 */
export function buildWorldProps(
  network: RoadNetwork,
  terrain: TerrainData,
  textures: WorldTextures,
): WorldPropsResult {
  const group = new THREE.Group();
  group.name = 'world-props';
  const geometries: THREE.BufferGeometry[] = [];
  const materials: THREE.Material[] = [];
  const colliders: WorldColliderDef[] = [];
  const cullableSectors: DistanceCullSector[] = [];

  const trackMat = <T extends THREE.Material>(m: T): T => {
    materials.push(m);
    return m;
  };
  const trackGeo = <T extends THREE.BufferGeometry>(g: T): T => {
    geometries.push(g);
    return g;
  };

  // Create bespoke botanical, rock, architectural, and infrastructure textures;
  // register in `textures.all` so `OpenWorld.dispose()` cleanly disposes every GPU texture.
  const maxAniso = textures.concrete?.anisotropy ?? 4;
  const craftTex = createFoliageAndPropTextures(maxAniso);
  textures.all.push(...craftTex.all);

  // --- Shared Photorealistic PBR Materials ---
  const concreteMat = trackMat(
    new THREE.MeshStandardMaterial({
      name: 'arch-concrete',
      map: craftTex.archConcrete,
      normalMap: craftTex.archConcreteNormal,
      normalScale: new THREE.Vector2(0.75, 0.75),
      roughness: 0.90,
      metalness: 0.03,
    }),
  );
  const crashHazardMat = trackMat(
    new THREE.MeshStandardMaterial({
      name: 'crash-hazard',
      map: craftTex.crashHazard,
      roughness: 0.64,
      metalness: 0.06,
    }),
  );
  const claddingMat = trackMat(
    new THREE.MeshStandardMaterial({
      name: 'dark-cladding',
      map: craftTex.cladding,
      normalMap: craftTex.claddingNormal,
      normalScale: new THREE.Vector2(0.85, 0.85),
      roughness: 0.56,
      metalness: 0.42,
    }),
  );
  const lightCladdingMat = trackMat(
    new THREE.MeshStandardMaterial({
      name: 'light-cladding',
      map: textures.corrugated,
      normalMap: craftTex.claddingNormal,
      normalScale: new THREE.Vector2(0.55, 0.55),
      color: 0xaab0b8,
      roughness: 0.62,
      metalness: 0.34,
    }),
  );
  const bayDoorMat = trackMat(
    new THREE.MeshStandardMaterial({
      name: 'bay-door',
      map: craftTex.bayDoor,
      roughness: 0.48,
      metalness: 0.44,
    }),
  );
  const glassWindowMat = trackMat(
    new THREE.MeshStandardMaterial({
      name: 'curtain-glass',
      map: craftTex.glassWindow,
      roughness: 0.14,
      metalness: 0.58,
      envMapIntensity: 1.35,
    }),
  );
  const steelDarkMat = trackMat(
    new THREE.MeshStandardMaterial({
      name: 'steel-dark',
      color: 0x262b33,
      roughness: 0.46,
      metalness: 0.70,
    }),
  );
  const steelGalvMat = trackMat(
    new THREE.MeshStandardMaterial({
      name: 'steel-galv',
      color: 0x9aa2ab,
      roughness: 0.40,
      metalness: 0.80,
    }),
  );
  const accentAmberMat = trackMat(
    new THREE.MeshStandardMaterial({
      name: 'accent-amber',
      color: 0xe2a220,
      roughness: 0.42,
      metalness: 0.18,
    }),
  );
  const roofDarkMat = trackMat(
    new THREE.MeshStandardMaterial({
      name: 'roof-dark',
      color: 0x333840,
      roughness: 0.80,
      metalness: 0.18,
    }),
  );
  const lampGlowMat = trackMat(
    new THREE.MeshStandardMaterial({
      name: 'lamp-glow',
      color: 0xfff0cc,
      emissive: 0xffd284,
      emissiveIntensity: 1.65,
      roughness: 0.25,
    }),
  );
  const reflectorAmberMat = trackMat(
    new THREE.MeshStandardMaterial({
      name: 'reflector-amber',
      color: 0xffb824,
      emissive: 0xd98410,
      emissiveIntensity: 0.55,
      roughness: 0.22,
      metalness: 0.35,
    }),
  );

  // Botanical, rock, and instanced prop materials
  const barkMat = trackMat(
    new THREE.MeshStandardMaterial({
      name: 'tree-bark',
      map: craftTex.bark,
      normalMap: craftTex.barkNormal,
      normalScale: new THREE.Vector2(1.0, 1.0),
      vertexColors: true,
      roughness: 0.94,
      metalness: 0.0,
    }),
  );
  /**
   * Preserves custom outward/upward botanical vertex normals on both sides of DoubleSide
   * foliage cards so backfaces never negate vNormal downward into pitch-black silhouettes.
   */
  const preserveFoliageNormals = (mat: THREE.MeshStandardMaterial): THREE.MeshStandardMaterial => {
    mat.customProgramCacheKey = () => 'foliage-preserve-botanical-normals-v1';
    mat.onBeforeCompile = (shader) => {
      shader.fragmentShader = shader.fragmentShader.replace(
        '#include <normal_fragment_begin>',
        `float faceDirection = 1.0;
         vec3 normal = normalize( vNormal );
         vec3 nonPerturbedNormal = normal;`,
      );
    };
    return mat;
  };

  const pineCanopyMat = trackMat(
    preserveFoliageNormals(
      new THREE.MeshStandardMaterial({
        name: 'pine-canopy',
        map: craftTex.pineBough,
        alphaTest: 0.42,
        side: THREE.DoubleSide,
        vertexColors: true,
        roughness: 0.84,
        metalness: 0.0,
      }),
    ),
  );
  const oakCanopyMat = trackMat(
    preserveFoliageNormals(
      new THREE.MeshStandardMaterial({
        name: 'oak-canopy',
        map: craftTex.oakLeaf,
        alphaTest: 0.42,
        side: THREE.DoubleSide,
        vertexColors: true,
        roughness: 0.82,
        metalness: 0.0,
      }),
    ),
  );
  const grassTuftMat = trackMat(
    preserveFoliageNormals(
      new THREE.MeshStandardMaterial({
        name: 'grass-tuft',
        map: craftTex.grassTuft,
        alphaTest: 0.36,
        side: THREE.DoubleSide,
        vertexColors: true,
        roughness: 0.88,
        metalness: 0.0,
      }),
    ),
  );
  const boulderMat = trackMat(
    new THREE.MeshStandardMaterial({
      name: 'canyon-rock',
      map: craftTex.rock,
      normalMap: craftTex.rockNormal,
      normalScale: new THREE.Vector2(1.1, 1.1),
      vertexColors: true,
      roughness: 0.92,
      metalness: 0.02,
    }),
  );
  const guardrailBeamMat = trackMat(
    new THREE.MeshStandardMaterial({
      name: 'guardrail-wbeam',
      map: craftTex.guardrail,
      roughness: 0.38,
      metalness: 0.78,
    }),
  );
  const vertexMetalMat = trackMat(
    new THREE.MeshStandardMaterial({
      name: 'inst-vertex-metal',
      vertexColors: true,
      roughness: 0.46,
      metalness: 0.62,
    }),
  );
  const vertexPolymerMat = trackMat(
    new THREE.MeshStandardMaterial({
      name: 'inst-vertex-polymer',
      vertexColors: true,
      roughness: 0.50,
      metalness: 0.06,
    }),
  );
  const chevronSignMat = trackMat(
    new THREE.MeshStandardMaterial({
      name: 'chevron-sign',
      map: craftTex.chevronSign,
      roughness: 0.38,
      metalness: 0.14,
    }),
  );

  const batcher = new MeshBatcher();
  batcher.useWorldUv(concreteMat, 4.2);
  batcher.useWorldUv(crashHazardMat, 2.6);
  batcher.useWorldUv(claddingMat, 4.5);
  batcher.useWorldUv(lightCladdingMat, 5.0);
  // Note: bayDoorMat and glassWindowMat keep explicit per-panel UVs (no worldUv).

  const flushBatch = (zoneName: string) => {
    const built = batcher.build(zoneName, { castShadow: true, receiveShadow: true });
    built.traverse((obj) => {
      if (obj instanceof THREE.Mesh) {
        obj.geometry.computeBoundingSphere();
        geometries.push(obj.geometry);
      }
    });
    group.add(built);
  };

  const addSolidBox = (
    id: string,
    tag: string,
    surface: BoxColliderDef['surface'],
    w: number,
    h: number,
    d: number,
    cx: number,
    cy: number,
    cz: number,
    yaw = 0,
  ) => {
    const col: BoxColliderDef = {
      type: 'box',
      id,
      tag,
      surface,
      position: [cx, cy, cz],
      halfExtents: [w * 0.5, h * 0.5, d * 0.5],
      friction: surface === 'metal' ? 0.45 : 0.75,
      restitution: 0.08,
    };
    if (Math.abs(yaw) > 1e-4) col.euler = [0, yaw, 0];
    colliders.push(col);
  };

  // -------------------------------------------------------------------------
  // 1. BLEND GARAGE HQ — MODERN CALIFORNIA MOTORSPORT SHOP (behind spawn at Z = -34)
  // -------------------------------------------------------------------------
  {
    const gx = 0;
    const gz = -34;
    const gw = 44;
    const gh = 10.5;
    const gd = 20;
    const frontZ = gz + gd * 0.5; // -24

    // Lower board-formed weathered concrete wainscot (y = 0..2.7m)
    batcher.slab(concreteMat, gw + 0.16, 2.7, gd + 0.16, gx, 0, gz);
    // Upper dark charcoal architectural ribbed steel cladding (y = 2.7..10.5m)
    batcher.slab(claddingMat, gw, gh - 2.7, gd, gx, 2.7, gz);
    // Heavy roof parapet fascia & motorsport amber accent band
    batcher.slab(steelDarkMat, gw + 1.1, 1.15, gd + 1.1, gx, gh, gz);
    batcher.slab(roofDarkMat, gw - 0.6, 0.3, gd - 0.6, gx, gh + 0.85, gz);
    batcher.slab(accentAmberMat, gw + 1.25, 0.34, gd + 1.25, gx, gh - 0.38, gz);

    // Structural concrete & steel vertical pilaster piers articulating the front elevation
    for (const px of [-21.4, -17.3, -8.7, -4.3, 4.3, 8.7, 17.3, 21.4]) {
      batcher.slab(concreteMat, 0.9, 5.2, 0.45, px, 0, frontZ + 0.18);
      batcher.slab(steelDarkMat, 0.42, 5.5, 0.38, px, 5.2, frontZ + 0.16);
    }
    // Corner architectural steel columns wrapping all 4 corners
    for (const cx of [-gw * 0.5, gw * 0.5]) {
      for (const cz of [gz - gd * 0.5, frontZ]) {
        batcher.slab(steelDarkMat, 0.65, gh + 1.1, 0.65, cx, 0, cz);
      }
    }

    // 3 Recessed Motorsport Roll-Up Workshop Bay Doors (x = -13, 0, +13)
    for (const bx of [-13, 0, 13]) {
      // Recessed dark steel portal jambs + deep I-beam lintel header
      batcher.slab(steelDarkMat, 7.6, 0.42, 0.55, bx, 4.68, frontZ + 0.20);
      batcher.slab(steelDarkMat, 0.30, 4.7, 0.50, bx - 3.65, 0, frontZ + 0.18);
      batcher.slab(steelDarkMat, 0.30, 4.7, 0.50, bx + 3.65, 0, frontZ + 0.18);
      // Sectional insulated roll-up garage door with vision glass row
      batcher.panel(bayDoorMat, 7.0, 4.65, bx, 2.34, frontZ + 0.14, 0);
      // Safety bollards flanking each bay doorway
      for (const side of [-4.05, 4.05]) {
        batcher.cyl(accentAmberMat, 0.11, 0.92, bx + side, 0.46, frontZ + 0.72, 'y', { segments: 10 });
        batcher.cyl(steelDarkMat, 0.13, 0.14, bx + side, 0.07, frontZ + 0.72, 'y', { segments: 10 });
      }
      // Exterior gooseneck sconce lamp mounted above bay lintel
      batcher.slab(steelDarkMat, 0.12, 0.12, 0.65, bx, 5.18, frontZ + 0.42);
      batcher.cyl(steelDarkMat, 0.22, 0.14, bx, 5.08, frontZ + 0.72, 'y', { radiusTop: 0.08, segments: 10 });
      batcher.cyl(lampGlowMat, 0.16, 0.06, bx, 5.0, frontZ + 0.72, 'y', { segments: 10 });
    }

    // Upper mezzanine architectural curtain-wall showroom windows (front wings + sides)
    for (const wx of [-14.2, 14.2]) {
      batcher.slab(steelDarkMat, 11.4, 3.05, 0.36, wx, 6.25, frontZ + 0.14);
      batcher.panel(glassWindowMat, 10.9, 2.65, wx, 7.77, frontZ + 0.34, 0);
      // Projecting horizontal steel sun-shade eyebrow louver
      batcher.slab(steelDarkMat, 11.6, 0.12, 0.85, wx, 9.25, frontZ + 0.46);
    }
    // Side showroom windows on east (+X) & west (-X) elevations
    for (const side of [-1, 1]) {
      const sx = side * (gw * 0.5 + 0.14);
      batcher.slab(steelDarkMat, 0.30, 2.9, 11.4, sx, 6.25, gz + 1.5);
      batcher.panel(glassWindowMat, 10.8, 2.55, sx + side * 0.17, 7.70, gz + 1.5, side > 0 ? Math.PI / 2 : -Math.PI / 2);
    }

    // Cantilevered Steel Entrance Canopy over the bays (exact original column footprint!)
    const canopyZ = frontZ + 2.75;
    batcher.slab(steelDarkMat, 38.4, 0.48, 5.5, gx, 5.38, canopyZ);
    batcher.slab(accentAmberMat, 38.6, 0.14, 0.12, gx, 5.72, frontZ + 5.52);
    // Exposed underside steel purlins & warm recessed canopy downlights
    for (let cx = -16; cx <= 16; cx += 4) {
      batcher.slab(steelDarkMat, 0.18, 0.24, 5.3, cx, 5.14, canopyZ);
    }
    for (const lx of [-15, -9, -3, 3, 9, 15]) {
      batcher.slab(lampGlowMat, 1.4, 0.06, 0.34, lx, 5.32, canopyZ + 0.4);
    }
    // 4 Structural I-beam canopy support columns + diagonal tension tie-rods to upper fascia
    for (const px of [-16, -5.5, 5.5, 16]) {
      addIBeamColumn(batcher, steelDarkMat, concreteMat, px, 0, frontZ + 5.1, 5.4, 0.42, 0.45);
      batcher.beam(steelGalvMat, [px, 5.75, frontZ + 5.0], [px, 8.75, frontZ + 0.15], 0.075, 0.075);
    }

    // Rooftop industrial HVAC units, exhaust ductwork & parapet railing detail
    for (const hx of [-12.5, 11.5]) {
      batcher.slab(steelGalvMat, 4.2, 1.55, 2.8, hx, gh + 1.1, gz - 1.5);
      batcher.slab(steelDarkMat, 3.6, 0.85, 0.14, hx, gh + 1.45, gz - 0.06);
      batcher.slab(steelGalvMat, 1.2, 0.65, 3.6, hx + 2.2, gh + 1.15, gz - 1.8);
    }
    batcher.slab(roofDarkMat, 3.4, 2.1, 3.2, 0, gh + 1.1, gz - 5.5);

    // Illuminated BLEND GARAGE fascia header sign in a recessed dark steel shadow box
    batcher.slab(steelDarkMat, 18.6, 4.65, 0.42, gx, 7.05, frontZ + 0.48);
    for (const lx of [-6.5, -2.2, 2.2, 6.5]) {
      batcher.slab(steelDarkMat, 0.10, 0.10, 0.72, lx, 11.45, frontZ + 0.92);
      batcher.slab(lampGlowMat, 0.42, 0.06, 0.18, lx, 11.38, frontZ + 1.22);
    }
    const signMat = trackMat(new THREE.MeshStandardMaterial({ map: textures.signs.garageHeader, roughness: 0.36, metalness: 0.16 }));
    const signGeo = trackGeo(new THREE.PlaneGeometry(18, 4.2));
    const signMesh = new THREE.Mesh(signGeo, signMat);
    signMesh.position.set(gx, 9.38, frontZ + 0.72);
    signMesh.updateMatrix();
    signMesh.matrixAutoUpdate = false;
    group.add(signMesh);

    addSolidBox('building-blend-garage', 'building', 'concrete', gw, gh + 1.5, gd, gx, (gh + 1.5) * 0.5, gz);

    // Side Service / Pit Canopy (west side of plaza at X = -34, Z = -14)
    batcher.slab(steelDarkMat, 14.4, 0.58, 18.4, -34, 4.9, -14);
    batcher.slab(roofDarkMat, 13.8, 0.25, 17.8, -34, 5.45, -14);
    batcher.slab(accentAmberMat, 14.6, 0.28, 18.6, -34, 5.48, -14);
    // Exposed roof cross purlins & pit canopy bay lights
    for (const pz of [-20, -16, -12, -8]) {
      batcher.slab(steelDarkMat, 13.6, 0.22, 0.20, -34, 4.68, pz);
      batcher.slab(lampGlowMat, 2.2, 0.06, 0.35, -34, 4.86, pz);
    }
    for (const px of [-40, -28]) {
      for (const pz of [-21, -7]) {
        addIBeamColumn(batcher, steelDarkMat, concreteMat, px, 0, pz, 4.9, 0.52, 0.55);
        addSolidBox(`canopy-col-${px}-${pz}`, 'pillar', 'metal', 0.65, 4.9, 0.65, px, 2.45, pz);
      }
    }
    flushBatch('structures-plaza');
  }

  // -------------------------------------------------------------------------
  // 2. EXPANDED CRASH TEST ARENA & AIRFIELD STUNT PARK (X: -540..-140, Z: 440..940)
  // -------------------------------------------------------------------------
  {
    const targetWallMat = trackMat(
      new THREE.MeshStandardMaterial({
        name: 'crash-target-wall',
        map: textures.targetWall,
        roughness: 0.62,
        metalness: 0.06,
      }),
    );

    // (a) Massive High-Speed Bullseye Concrete Crash Target Wall at X = -216, Z = 620.
    const wallX = -216;
    const wallZ = 620;
    batcher.slab(concreteMat, 3.2, 4.6, 18.4, wallX, 0, wallZ);
    batcher.slab(steelDarkMat, 3.4, 0.28, 18.6, wallX, 4.58, wallZ);
    // Yellow/black bullseye crash-test target panel on oncoming (-X) impact face!
    const bullseyeGeo = trackGeo(new THREE.PlaneGeometry(17.6, 4.2));
    const bullseyeMesh = new THREE.Mesh(bullseyeGeo, targetWallMat);
    bullseyeMesh.position.set(wallX - 1.64, 2.3, wallZ);
    bullseyeMesh.rotation.y = -Math.PI / 2;
    bullseyeMesh.updateMatrix();
    bullseyeMesh.matrixAutoUpdate = false;
    group.add(bullseyeMesh);

    // Heavy rear steel truss buttresses & concrete anchor blocks.
    for (const bz of [613, 620, 627]) {
      batcher.slab(concreteMat, 3.2, 1.1, 1.25, wallX + 3.4, 0, bz);
      batcher.beam(steelDarkMat, [wallX + 1.5, 4.35, bz], [wallX + 4.7, 0.9, bz], 0.36, 0.36);
      batcher.beam(steelDarkMat, [wallX + 1.5, 2.35, bz], [wallX + 3.6, 0.9, bz], 0.26, 0.26);
    }
    batcher.slab(steelDarkMat, 0.32, 0.32, 15.2, wallX + 3.0, 2.55, wallZ);
    addSolidBox('pg-main-crash-wall', 'wall', 'concrete', 3.4, 4.6, 18.4, wallX, 2.3, wallZ);

    // Overhead TARGET WALL sign.
    const wallSignMat = trackMat(new THREE.MeshStandardMaterial({ map: textures.signs.impactWallSign, roughness: 0.42 }));
    const wallSign = new THREE.Mesh(trackGeo(new THREE.PlaneGeometry(8.4, 3.8)), wallSignMat);
    wallSign.position.set(wallX - 1.75, 6.8, wallZ);
    wallSign.rotation.y = -Math.PI / 2;
    wallSign.updateMatrix();
    wallSign.matrixAutoUpdate = false;
    group.add(wallSign);
    batcher.slab(steelDarkMat, 0.3, 4.4, 0.3, wallX - 0.8, 4.5, wallZ - 3.6);
    batcher.slab(steelDarkMat, 0.3, 4.4, 0.3, wallX - 0.8, 4.5, wallZ + 3.6);

    // (b) Offset Small-Overlap Concrete Barrier Block at X = -216, Z = 656.
    batcher.slab(concreteMat, 2.8, 3.0, 5.2, wallX, 0, 656);
    batcher.slab(crashHazardMat, 0.16, 2.7, 4.8, wallX - 1.44, 0.15, 656);
    addSolidBox('pg-offset-crash-wall', 'wall', 'concrete', 3.0, 3.0, 5.2, wallX, 1.5, 656);

    // (c) 4 Heavy Steel-Banded Hazard Crash-Test Pillars (Pole Impact Zone around Z = 650..695).
    const pillarCoords: readonly [number, number][] = [
      [-288, 652],
      [-264, 668],
      [-242, 654],
      [-252, 686],
    ];
    for (let i = 0; i < pillarCoords.length; i++) {
      const [px, pz] = pillarCoords[i];
      batcher.cyl(crashHazardMat, 0.56, 3.8, px, 1.9, pz, 'y', { segments: 14 });
      batcher.cyl(steelDarkMat, 0.78, 0.18, px, 0.09, pz, 'y', { segments: 14 });
      batcher.cyl(steelDarkMat, 0.62, 0.16, px, 1.4, pz, 'y', { segments: 14 });
      batcher.cyl(steelDarkMat, 0.62, 0.16, px, 2.7, pz, 'y', { segments: 14 });
      batcher.cyl(reflectorAmberMat, 0.58, 0.16, px, 3.85, pz, 'y', { segments: 14 });
      const cylCol: CylinderColliderDef = {
        type: 'cylinder',
        id: `pg-crash-pillar-${i}`,
        tag: 'pillar',
        surface: 'metal',
        position: [px, 1.9, pz],
        radius: 0.58,
        halfHeight: 1.9,
        friction: 0.5,
        restitution: 0.12,
      };
      colliders.push(cylCol);
    }

    // (d) 3 Progressive Airfield Stunt Jump Ramps (Small, Medium, Mega) + Landing Ramps!
    const rampSpecs: readonly {
      id: string;
      z: number;
      startX: number;
      len: number;
      width: number;
      height: number;
      landStartX: number;
      landLen: number;
      landHeight: number;
    }[] = [
      { id: 'small', z: 505, startX: -420, len: 16, width: 10.5, height: 1.9, landStartX: -386, landLen: 22, landHeight: 1.55 },
      { id: 'medium', z: 540, startX: -420, len: 24, width: 11.5, height: 3.2, landStartX: -370, landLen: 30, landHeight: 2.45 },
      { id: 'mega', z: 576, startX: -420, len: 36, width: 13.5, height: 5.4, landStartX: -338, landLen: 44, landHeight: 3.9 },
    ];

    for (const r of rampSpecs) {
      const launchProfile: [number, number][] = [];
      const steps = 10;
      for (let i = 0; i <= steps; i++) {
        const t = i / steps;
        launchProfile.push([r.startX + t * r.len, r.height * Math.pow(t, 1.42)]);
      }
      const launchBuilt = buildProfilePrism(launchProfile, r.z, r.width, `pg-launch-${r.id}`, 'ramp', 'concrete');
      trackGeo(launchBuilt.geometry);
      const launchMesh = new THREE.Mesh(launchBuilt.geometry, concreteMat);
      launchMesh.name = `pg-launch-${r.id}`;
      launchMesh.castShadow = true;
      launchMesh.receiveShadow = true;
      launchMesh.matrixAutoUpdate = false;
      group.add(launchMesh);
      colliders.push(launchBuilt.collider);

      batcher.slab(crashHazardMat, 0.42, r.height + 0.08, r.width + 0.2, r.startX + r.len + 0.19, 0, r.z);

      const landProfile: [number, number][] = [
        [r.landStartX, r.landHeight],
        [r.landStartX + 4, r.landHeight],
        [r.landStartX + r.landLen * 0.55, r.landHeight * 0.48],
        [r.landStartX + r.landLen, 0],
      ];
      const landBuilt = buildProfilePrism(landProfile, r.z, r.width + 1.2, `pg-land-${r.id}`, 'ramp', 'concrete');
      trackGeo(landBuilt.geometry);
      const landMesh = new THREE.Mesh(landBuilt.geometry, concreteMat);
      landMesh.name = `pg-land-${r.id}`;
      landMesh.castShadow = true;
      landMesh.receiveShadow = true;
      landMesh.matrixAutoUpdate = false;
      group.add(landMesh);
      colliders.push(landBuilt.collider);
      batcher.slab(crashHazardMat, 0.35, r.landHeight, r.width + 1.3, r.landStartX - 0.18, 0, r.z);
    }

    // Stunt ramp signage.
    const rampSignMat = trackMat(new THREE.MeshStandardMaterial({ map: textures.signs.rampSign, roughness: 0.42 }));
    const rampSign = new THREE.Mesh(trackGeo(new THREE.PlaneGeometry(5.2, 2.6)), rampSignMat);
    rampSign.position.set(-428, 3.2, 492);
    rampSign.rotation.y = -Math.PI / 2;
    rampSign.updateMatrix();
    rampSign.matrixAutoUpdate = false;
    group.add(rampSign);
    batcher.slab(steelGalvMat, 0.14, 3.6, 0.14, -427.8, 0, 490.2);
    batcher.slab(steelGalvMat, 0.14, 3.6, 0.14, -427.8, 0, 493.8);

    const megaSignMat = trackMat(new THREE.MeshStandardMaterial({ map: textures.signs.megaRampSign, roughness: 0.42 }));
    const megaSign = new THREE.Mesh(trackGeo(new THREE.PlaneGeometry(5.6, 2.8)), megaSignMat);
    megaSign.position.set(-428, 3.4, 591);
    megaSign.rotation.y = -Math.PI / 2;
    megaSign.updateMatrix();
    megaSign.matrixAutoUpdate = false;
    group.add(megaSign);
    batcher.slab(steelGalvMat, 0.14, 3.8, 0.14, -427.8, 0, 589.2);
    batcher.slab(steelGalvMat, 0.14, 3.8, 0.14, -427.8, 0, 592.8);

    // (e) Suspension Speed-Bump & Articulation Strip at Z = 880 (X = -460..-320).
    const bumpSpecs: { x: number; z: number; w: number; h: number }[] = [];
    for (let i = 0; i < 8; i++) {
      bumpSpecs.push({ x: -458 + i * 9.5, z: 880, w: 11.2, h: 0.16 });
    }
    for (let i = 0; i < 6; i++) {
      bumpSpecs.push({ x: -376 + i * 5.8, z: i % 2 === 0 ? 877.4 : 882.6, w: 4.8, h: 0.19 });
    }

    const bumpVerts: number[] = [];
    const bumpUvs: number[] = [];
    const bumpIndices: number[] = [];
    let bumpVertOffset = 0;
    for (let i = 0; i < bumpSpecs.length; i++) {
      const b = bumpSpecs[i];
      const profile: [number, number][] = [
        [b.x - 1.2, 0],
        [b.x - 0.45, b.h],
        [b.x + 0.45, b.h],
        [b.x + 1.2, 0],
      ];
      const built = buildProfilePrism(profile, b.z, b.w, `pg-bump-${i}`, 'bump', 'asphalt');
      const posArr = built.geometry.attributes.position.array as Float32Array;
      const uvArr = built.geometry.attributes.uv.array as Float32Array;
      const idxArr = built.collider.indices;
      for (let k = 0; k < posArr.length; k++) bumpVerts.push(posArr[k]);
      for (let k = 0; k < uvArr.length; k++) bumpUvs.push(uvArr[k]);
      for (let k = 0; k < idxArr.length; k++) bumpIndices.push(idxArr[k] + bumpVertOffset);
      bumpVertOffset += posArr.length / 3;
      built.geometry.dispose();
    }

    const combinedBumpVerts = new Float32Array(bumpVerts);
    const combinedBumpIdx = new Uint32Array(bumpIndices);
    const combinedBumpGeo = trackGeo(new THREE.BufferGeometry());
    combinedBumpGeo.setAttribute('position', new THREE.BufferAttribute(combinedBumpVerts, 3));
    combinedBumpGeo.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(bumpUvs), 2));
    combinedBumpGeo.setIndex(new THREE.BufferAttribute(combinedBumpIdx, 1));
    combinedBumpGeo.computeVertexNormals();

    const bumpMesh = new THREE.Mesh(combinedBumpGeo, crashHazardMat);
    bumpMesh.name = 'pg-suspension-bumps';
    bumpMesh.receiveShadow = true;
    bumpMesh.matrixAutoUpdate = false;
    group.add(bumpMesh);

    colliders.push({
      type: 'trimesh',
      id: 'pg-suspension-bumps',
      tag: 'bump',
      surface: 'asphalt',
      friction: 0.9,
      restitution: 0.04,
      vertices: new Float32Array(combinedBumpVerts),
      indices: new Uint32Array(combinedBumpIdx),
    });

    // (f) Crash Test Lab & Glazed Airfield Control Tower overlooking the entire Stunt Park (X = -172, Z = 555).
    const labX = -172;
    const labZ = 555;
    batcher.slab(concreteMat, 20.2, 2.8, 42.2, labX, 0, labZ);
    batcher.slab(claddingMat, 20, 7.6, 42, labX, 2.8, labZ);
    batcher.slab(steelDarkMat, 20.8, 1.1, 42.8, labX, 10.4, labZ);
    batcher.slab(accentAmberMat, 21.0, 0.35, 43.0, labX, 10.0, labZ);
    batcher.panel(bayDoorMat, 6.4, 4.5, labX - 10.12, 2.25, labZ - 12, -Math.PI / 2);
    // Glazed Airfield Control Tower cab.
    batcher.slab(steelDarkMat, 9.2, 0.5, 16.0, labX - 6.0, 11.5, labZ);
    batcher.slab(glassWindowMat, 8.4, 3.8, 15.2, labX - 6.0, 12.0, labZ);
    batcher.slab(roofDarkMat, 9.8, 0.75, 16.6, labX - 6.0, 15.8, labZ);
    addSolidBox('building-crash-lab', 'building', 'concrete', 20.6, 12, 42.6, labX, 6.0, labZ);

    const labSignMat = trackMat(new THREE.MeshStandardMaterial({ map: textures.signs.crashLabBanner, roughness: 0.4 }));
    const labSign = new THREE.Mesh(trackGeo(new THREE.PlaneGeometry(18, 4.2)), labSignMat);
    labSign.position.set(labX - 10.35, 7.6, labZ);
    labSign.rotation.y = -Math.PI / 2;
    labSign.updateMatrix();
    labSign.matrixAutoUpdate = false;
    group.add(labSign);

    const slalomSignMat = trackMat(new THREE.MeshStandardMaterial({ map: textures.signs.slalomSign, roughness: 0.42 }));
    const slalomSign = new THREE.Mesh(trackGeo(new THREE.PlaneGeometry(5.2, 2.6)), slalomSignMat);
    slalomSign.position.set(-462, 3.1, 760);
    slalomSign.rotation.y = -Math.PI / 2;
    slalomSign.updateMatrix();
    slalomSign.matrixAutoUpdate = false;
    group.add(slalomSign);
    batcher.slab(steelGalvMat, 0.14, 3.5, 0.14, -461.8, 0, 758.2);
    batcher.slab(steelGalvMat, 0.14, 3.5, 0.14, -461.8, 0, 761.8);

    // Precast New Jersey F-shape concrete safety barrier wall protecting the Crash Test Lab & Control Tower.
    for (let i = 0; i < 12; i++) {
      const bz = 515 + i * 6.5;
      batcher.add(concreteMat, buildJerseyBarrierGeometry(6.35, 1.25, 0.98), -192, 0, bz);
    }
    addSolidBox('pg-lab-guard-wall', 'barrier', 'concrete', 1.1, 1.3, 78, -192, 0.65, 551);

    flushBatch('structures-proving');
  }

  // -------------------------------------------------------------------------
  // 2B. STEEL-ARCH PACIFIC COAST BRIDGE (X = -720, Z = -128..+128, deckY = 14.5m)
  // -------------------------------------------------------------------------
  {
    const bx = COAST_BRIDGE_BOUNDS.centerX;
    const deckY = COAST_BRIDGE_BOUNDS.deckY;
    const spanLen = COAST_BRIDGE_BOUNDS.maxZ - COAST_BRIDGE_BOUNDS.minZ; // 256m
    const halfW = COAST_BRIDGE_BOUNDS.halfWidth; // 7.4m
    const deckThick = 1.4;

    // Reinforced concrete box-girder bridge deck + side parapets.
    batcher.slab(concreteMat, halfW * 2 + 1.2, deckThick, spanLen + 12, bx, deckY - deckThick, 0);
    // Solid bridge deck collider (top surface sits at exact deckY = 14.5m!).
    addSolidBox('coast-bridge-deck', 'road', 'concrete', halfW * 2 + 1.0, deckThick, spanLen + 16, bx, deckY - deckThick * 0.5, 0);

    // Left & right bridge concrete parapet walls + galvanized steel safety rails (prevents falling into ocean!).
    for (const side of [-1, 1]) {
      const rx = bx + side * (halfW + 0.35);
      batcher.slab(concreteMat, 0.55, 0.95, spanLen + 10, rx, deckY, 0);
      batcher.slab(steelGalvMat, 0.16, 0.14, spanLen + 10, rx, deckY + 1.15, 0);
      addSolidBox(`coast-bridge-rail-${side > 0 ? 'E' : 'W'}`, 'barrier', 'concrete', 0.65, 1.35, spanLen + 12, rx, deckY + 0.68, 0);
    }

    // Massive concrete bridge abutments & submerged ocean piers.
    for (const pz of [-128, -68, 68, 128]) {
      batcher.slab(concreteMat, halfW * 2 + 3.2, deckY + 12, 5.2, bx, -12, pz);
    }

    // Twin dramatic parabolic structural steel arches rising 24m above the bridge deck + vertical hanger cables!
    const archSegs = 18;
    const archSpan = 216;
    const archRise = 24.5;
    for (const side of [-1, 1]) {
      const ax = bx + side * (halfW + 0.35);
      for (let i = 0; i < archSegs; i++) {
        const u0 = (i / archSegs) * 2 - 1;
        const u1 = ((i + 1) / archSegs) * 2 - 1;
        const z0 = u0 * (archSpan * 0.5);
        const z1 = u1 * (archSpan * 0.5);
        const y0 = deckY + (1 - u0 * u0) * archRise;
        const y1 = deckY + (1 - u1 * u1) * archRise;
        batcher.beam(steelDarkMat, [ax, y0, z0], [ax, y1, z1], 0.95, 0.95);
        // Vertical steel hanger cable down to deck.
        if (i > 0 && i < archSegs && y0 > deckY + 2.0) {
          batcher.cyl(steelGalvMat, 0.11, y0 - deckY, ax, deckY + (y0 - deckY) * 0.5, z0, 'y', { segments: 6 });
        }
      }
    }
    // Overhead cross-bracing uniting the twin steel arches across the roadway!
    for (let i = 3; i <= archSegs - 3; i += 2) {
      const u = (i / archSegs) * 2 - 1;
      const zc = u * (archSpan * 0.5);
      const yc = deckY + (1 - u * u) * archRise;
      if (yc > deckY + 9.0) {
        batcher.beam(steelDarkMat, [bx - halfW - 0.35, yc, zc], [bx + halfW + 0.35, yc, zc], 0.52, 0.52);
      }
    }
    flushBatch('structures-bridge');
  }

  // -------------------------------------------------------------------------
  // 2C. ILLUMINATED 280M CONCRETE MOUNTAIN TUNNEL (Z = -620, X = -160..+120)
  // -------------------------------------------------------------------------
  {
    const tx0 = TUNNEL_BOUNDS.minX;
    const tx1 = TUNNEL_BOUNDS.maxX;
    const tcx = (tx0 + tx1) * 0.5; // -20
    const tLen = tx1 - tx0; // 280m
    const tcz = TUNNEL_BOUNDS.centerZ; // -620
    const fy = TUNNEL_BOUNDS.floorY; // 12.0
    const hw = TUNNEL_BOUNDS.halfWidth; // 10.5
    const clearH = TUNNEL_BOUNDS.ceilingY - fy; // 8.4m

    // Thick concrete tunnel side walls, angled haunches, and ceiling deck.
    for (const side of [-1, 1]) {
      const wz = tcz + side * (hw + 1.2);
      batcher.slab(concreteMat, tLen, clearH + 1.6, 2.4, tcx, fy - 0.5, wz);
      // Raised concrete emergency maintenance curb inside tunnel.
      batcher.slab(concreteMat, tLen, 0.55, 0.85, tcx, fy, tcz + side * (hw - 0.42));
      // Solid tunnel wall collider.
      addSolidBox(`tunnel-wall-${side > 0 ? 'S' : 'N'}`, 'wall', 'concrete', tLen, clearH + 2.0, 2.6, tcx, fy + clearH * 0.5, wz);
    }
    // Tunnel roof ceiling slab + solid collider.
    batcher.slab(concreteMat, tLen, 1.8, (hw + 2.4) * 2, tcx, fy + clearH, tcz);
    addSolidBox('tunnel-ceiling', 'wall', 'concrete', tLen, 2.0, (hw + 2.0) * 2, tcx, fy + clearH + 1.0, tcz);

    // Interior structural concrete vault ribs & warm glowing overhead tunnel light strips (zero GPU point lights!).
    for (let rx = tx0 + 8; rx <= tx1 - 8; rx += 16) {
      batcher.slab(steelDarkMat, 0.48, clearH, 0.35, rx, fy, tcz - hw + 0.15);
      batcher.slab(steelDarkMat, 0.48, clearH, 0.35, rx, fy, tcz + hw - 0.15);
      batcher.slab(steelDarkMat, 0.48, 0.38, hw * 2, rx, fy + clearH - 0.38, tcz);
      // Twin warm glowing sodium/LED overhead ceiling light bars!
      batcher.slab(lampGlowMat, 4.8, 0.12, 0.42, rx, fy + clearH - 0.16, tcz - 4.4);
      batcher.slab(lampGlowMat, 4.8, 0.12, 0.42, rx, fy + clearH - 0.16, tcz + 4.4);
    }

    // Architectural concrete portal facades at West (X = -160) & East (X = +120) entrances + SIERRA RIDGE TUNNEL signs.
    const tunnelSignMat = trackMat(new THREE.MeshStandardMaterial({ map: textures.signs.tunnelPortal, roughness: 0.42 }));
    const tunnelSignGeo = trackGeo(new THREE.PlaneGeometry(13.5, 3.2));
    for (const px of [tx0, tx1]) {
      const dir = px === tx0 ? -1 : 1;
      batcher.slab(concreteMat, 3.2, 4.2, (hw + 4.5) * 2, px, fy + clearH + 0.4, tcz);
      batcher.slab(concreteMat, 3.4, clearH + 4.5, 4.2, px, fy - 0.5, tcz - hw - 2.6);
      batcher.slab(concreteMat, 3.4, clearH + 4.5, 4.2, px, fy - 0.5, tcz + hw + 2.6);
      batcher.slab(crashHazardMat, 0.2, 3.8, 1.4, px + dir * 1.65, fy + 0.1, tcz - hw - 0.8);
      batcher.slab(crashHazardMat, 0.2, 3.8, 1.4, px + dir * 1.65, fy + 0.1, tcz + hw + 0.8);

      const pSign = new THREE.Mesh(tunnelSignGeo, tunnelSignMat);
      pSign.position.set(px + dir * 1.72, fy + clearH + 2.5, tcz);
      pSign.rotation.y = dir < 0 ? -Math.PI / 2 : Math.PI / 2;
      pSign.updateMatrix();
      pSign.matrixAutoUpdate = false;
      group.add(pSign);
    }
    flushBatch('structures-tunnel');

    // Hollow Sculpted Mountain Ridge Overpass Cap arching cleanly over the 280m tunnel roof!
    const capSegX = 24;
    const capSegZ = 14;
    const capW = tLen - 4;
    const capD = 128;
    const capGeo = trackGeo(new THREE.PlaneGeometry(capW, capD, capSegX, capSegZ));
    capGeo.rotateX(-Math.PI / 2);
    const cPos = capGeo.attributes.position as THREE.BufferAttribute;
    const cCols = new Float32Array(cPos.count * 3);
    const cRock = new THREE.Color(0x7c7060);
    const cGrass = new THREE.Color(0x6b7048);
    const cTmp = new THREE.Color();

    for (let i = 0; i < cPos.count; i++) {
      const lx = cPos.getX(i);
      const lz = cPos.getZ(i);
      const wx = tcx + lx;
      const wz = tcz + lz;
      const nx = lx / (capW * 0.5); // -1..+1 along tunnel length
      const nz = lz / (capD * 0.5); // -1..+1 across mountain width
      const edgeZ = Math.abs(nz);
      const archEnvelope = Math.max(0, 1 - edgeZ * edgeZ);
      const endTaper = clamp(1 - Math.pow(Math.abs(nx), 4.0) * 0.55, 0.35, 1.0);
      const ridgeH = Math.sin(wx * 0.035) * 4.5 + Math.cos(wz * 0.045) * 3.2;

      const groundY = terrain.sampleHeight(wx, wz);
      const roofPeak = fy + clearH + 2.2 + archEnvelope * endTaper * (28 + ridgeH);
      // Seamlessly stitch north/south skirts into actual terrain while staying cleanly above the tunnel vault!
      const y = edgeZ > 0.85 ? groundY - 0.8 : Math.max(fy + clearH + 1.6, lerp(groundY - 0.6, roofPeak, Math.pow(archEnvelope, 0.65)));
      cPos.setXYZ(i, wx, y, wz);

      const rockBlend = clamp((y - 22) / 24, 0.25, 0.92);
      cTmp.copy(cGrass).lerp(cRock, rockBlend);
      cCols[i * 3] = cTmp.r;
      cCols[i * 3 + 1] = cTmp.g;
      cCols[i * 3 + 2] = cTmp.b;
    }
    capGeo.setAttribute('color', new THREE.BufferAttribute(cCols, 3));
    capGeo.computeVertexNormals();
    const capMat = trackMat(new THREE.MeshLambertMaterial({ vertexColors: true }));
    const capMesh = new THREE.Mesh(capGeo, capMat);
    capMesh.name = 'tunnel-mountain-cap';
    capMesh.castShadow = false;
    capMesh.receiveShadow = true;
    capMesh.matrixAutoUpdate = false;
    group.add(capMesh);
  }

  // -------------------------------------------------------------------------
  // 3. ROADSIDE BUILDINGS, SERVICE STATION & RED-ROCK RALLY ARCH
  // -------------------------------------------------------------------------
  {
    // Highway Service Station & Pit Canopy along South Expressway Straightaway (X = -155, Z = 294..312).
    batcher.slab(concreteMat, 22.3, 1.8, 11.3, -155, 0, 294);
    batcher.slab(claddingMat, 22, 4.6, 11, -155, 1.8, 294);
    batcher.slab(steelDarkMat, 22.8, 0.75, 11.8, -155, 6.4, 294);
    batcher.slab(accentAmberMat, 22.9, 0.25, 11.9, -155, 6.1, 294);
    batcher.panel(glassWindowMat, 10.1, 3.2, -160.0, 2.4, 299.72, 0);
    batcher.panel(bayDoorMat, 6.6, 4.3, -149.2, 2.15, 299.62, 0);
    batcher.slab(steelDarkMat, 26.4, 0.72, 11.4, -155, 5.2, 312);
    batcher.slab(accentAmberMat, 26.7, 0.30, 11.7, -155, 5.88, 312);
    for (const px of [-165, -155, -145]) {
      addIBeamColumn(batcher, steelDarkMat, concreteMat, px, 0, 312, 5.2, 0.50, 0.65);
      addSolidBox(`service-col-${px}`, 'pillar', 'metal', 0.65, 5.2, 0.65, px, 2.6, 312);
    }
    addSolidBox('building-service-station', 'building', 'concrete', 22.4, 6.8, 11.4, -155, 3.4, 294);

    // Two industrial motorsport warehouses framing the central valley.
    const warehouses: readonly { id: string; x: number; z: number; w: number; h: number; d: number; yaw: number }[] = [
      { id: 'warehouse-east', x: 265, z: 245, w: 30, h: 10, d: 18, yaw: 0 },
      { id: 'warehouse-west', x: -245, z: 220, w: 28, h: 9.2, d: 18, yaw: 0.1 },
    ];
    for (const wh of warehouses) {
      const groundY = terrain.sampleHeight(wh.x, wh.z);
      batcher.at(wh.x, groundY, wh.z, wh.yaw, () => {
        batcher.slab(concreteMat, wh.w + 0.25, 3.0, wh.d + 0.25, 0, -0.8, 0);
        batcher.slab(lightCladdingMat, wh.w, wh.h - 2.2, wh.d, 0, 2.2, 0);
        batcher.slab(roofDarkMat, wh.w + 0.9, 0.85, wh.d + 0.9, 0, wh.h - 0.8, 0);
        batcher.slab(accentAmberMat, wh.w + 1.0, 0.30, wh.d + 1.0, 0, wh.h - 1.35, 0);
        batcher.panel(bayDoorMat, 5.4, 4.2, -wh.w * 0.24, 1.3, wh.d * 0.5 + 0.18, 0);
        batcher.panel(bayDoorMat, 5.4, 4.2, wh.w * 0.24, 1.3, wh.d * 0.5 + 0.18, 0);
      });
      addSolidBox(wh.id, 'building', 'concrete', wh.w, wh.h, wh.d, wh.x, groundY + wh.h * 0.5 - 0.8, wh.z, wh.yaw);
    }
  }

  // -------------------------------------------------------------------------
  // 4. STEEL-TRUSS OVERHEAD HIGHWAY & DIRECTIONAL SIGN GANTRIES
  // -------------------------------------------------------------------------
  const addSignGantry = (
    id: string,
    cx: number,
    cz: number,
    yaw: number,
    span: number,
    signTex: THREE.Texture,
    doubleSided = false,
  ) => {
    const baseY = terrain.sampleHeight(cx, cz);
    const clearance = 6.8;
    const halfSpan = span * 0.5;
    const trussBot = clearance + 0.25;
    const trussTop = clearance + 1.85;
    const trussDepth = 0.44;

    batcher.at(cx, baseY, cz, yaw, () => {
      // Twin-post steel truss towers + concrete pedestals outside the roadway
      for (const side of [-1, 1]) {
        const tx = side * halfSpan;
        batcher.slab(concreteMat, 1.15, 1.05, 1.65, tx, -0.45, 0);
        batcher.cyl(steelGalvMat, 0.18, clearance + 1.65, tx, (clearance + 1.65) * 0.5 + 0.4, -trussDepth, 'y', { segments: 10 });
        batcher.cyl(steelGalvMat, 0.18, clearance + 1.65, tx, (clearance + 1.65) * 0.5 + 0.4, trussDepth, 'y', { segments: 10 });
        // Tower horizontal rungs & diagonal X-bracing
        for (let ty = 1.6; ty < clearance + 0.5; ty += 1.6) {
          batcher.beam(steelGalvMat, [tx, ty, -trussDepth], [tx, ty, trussDepth], 0.10, 0.10);
          batcher.beam(steelGalvMat, [tx, ty, -trussDepth], [tx, ty + 1.6, trussDepth], 0.08, 0.08);
          batcher.beam(steelGalvMat, [tx, ty + 1.6, -trussDepth], [tx, ty, trussDepth], 0.08, 0.08);
        }
      }

      // 4 Horizontal box-truss chord tubes spanning the road
      for (const cy of [trussBot, trussTop]) {
        for (const czOff of [-trussDepth, trussDepth]) {
          batcher.cyl(steelGalvMat, 0.12, span + 0.9, 0, cy, czOff, 'x', { segments: 10 });
        }
      }

      // Warren-truss diagonal web struts across front, back, top, and bottom faces
      const bays = Math.max(6, Math.round(span / 1.9));
      const bayW = span / bays;
      for (let i = 0; i < bays; i++) {
        const x0 = -halfSpan + i * bayW;
        const x1 = x0 + bayW;
        const up = i % 2 === 0;
        const yA = up ? trussBot : trussTop;
        const yB = up ? trussTop : trussBot;
        batcher.beam(steelGalvMat, [x0, yA, -trussDepth], [x1, yB, -trussDepth], 0.085, 0.085);
        batcher.beam(steelGalvMat, [x0, yA, trussDepth], [x1, yB, trussDepth], 0.085, 0.085);
        batcher.beam(steelGalvMat, [x0, trussBot, -trussDepth], [x0, trussTop, -trussDepth], 0.085, 0.085);
        batcher.beam(steelGalvMat, [x0, trussBot, trussDepth], [x0, trussTop, trussDepth], 0.085, 0.085);
        batcher.beam(steelGalvMat, [x0, trussBot, -trussDepth], [x1, trussBot, trussDepth], 0.075, 0.075);
        batcher.beam(steelGalvMat, [x0, trussTop, -trussDepth], [x1, trussTop, trussDepth], 0.075, 0.075);
      }

      // Dark anodized steel sign backing bezels flush behind front/back sign faces
      const signW = Math.min(13, span * 0.65);
      batcher.slab(steelDarkMat, signW + 0.24, 3.24, 0.08, 0, clearance - 0.56, -0.46);
      if (doubleSided) {
        batcher.slab(steelDarkMat, signW + 0.24, 3.24, 0.08, 0, clearance - 0.56, 0.46);
      }
    });

    // Merge front + optional back sign faces into ONE crisp mesh per gantry (halving sign draw calls!)
    const signW = Math.min(13, span * 0.65);
    const signH = 3.1;
    const faceParts: THREE.BufferGeometry[] = [];
    const frontGeo = new THREE.PlaneGeometry(signW, signH);
    frontGeo.rotateY(Math.PI);
    frontGeo.translate(0, 0, -0.52);
    faceParts.push(frontGeo);
    if (doubleSided) {
      const backGeo = new THREE.PlaneGeometry(signW, signH);
      backGeo.translate(0, 0, 0.52);
      faceParts.push(backGeo);
    }
    const mergedSignGeo = trackGeo(mergeColoredParts(faceParts));
    const sMat = trackMat(new THREE.MeshStandardMaterial({ map: signTex, roughness: 0.38, metalness: 0.12 }));
    const signMesh = new THREE.Mesh(mergedSignGeo, sMat);
    signMesh.name = `sign:${id}`;
    signMesh.position.set(cx, baseY + clearance + 1.05, cz);
    signMesh.rotation.y = yaw;
    signMesh.updateMatrix();
    signMesh.matrixAutoUpdate = false;
    group.add(signMesh);

    // Colliders ONLY on the two side support legs (roadway remains 100% clear!).
    const cos = Math.cos(yaw);
    const sin = Math.sin(yaw);
    for (const side of [-1, 1]) {
      const lx = cx + side * halfSpan * cos;
      const lz = cz - side * halfSpan * sin;
      addSolidBox(`${id}-leg-${side > 0 ? 'L' : 'R'}`, 'pillar', 'metal', 0.75, clearance + 1.8, 0.75, lx, baseY + (clearance + 1.8) * 0.5, lz, yaw);
    }
  };

  addSignGantry('gantry-plaza-highway', 0, 68, 0, 18.0, textures.signs.highwayGantry, true);
  addSignGantry('gantry-plaza-coast', -68, 12, -Math.PI / 2, 16.0, textures.signs.coastGantry, true);
  addSignGantry('gantry-plaza-canyon', 72, -28, Math.PI * 0.65, 16.0, textures.signs.canyonEntry, true);
  addSignGantry('gantry-plaza-desert', 68, 18, Math.PI / 2, 16.5, textures.signs.desertGantry, true);
  addSignGantry('gantry-highway-straight', 0, 340, Math.PI / 2, 22.5, textures.signs.highwayGantry, true);
  addSignGantry('gantry-airfield-entry', -340, 444, 0, 21.0, textures.signs.provingEntry, true);

  // Align the Red-Rock Rally Stage arch directly onto the dirt rally spline ~45m ahead of the desert spawn
  // so both legs straddle cleanly outside the 7.2m gravel shoulders with an unobstructed launch lane!
  const desertRallyRoad = network.roads.find((r) => r.id === 'desert-rally-loop');
  if (desertRallyRoad && desertRallyRoad.samples.length > 0) {
    const archSample = desertRallyRoad.samples[Math.floor(desertRallyRoad.samples.length * 0.055)];
    addSignGantry(
      'gantry-desert-rally-arch',
      archSample.x,
      archSample.z,
      archSample.heading,
      19.6,
      textures.signs.rallyArch,
      true,
    );
  }

  // Flush roadside buildings & highway gantries into their own frustum-cullable zone batch.
  flushBatch('structures-roadside');

  // -------------------------------------------------------------------------
  // 5. INSTANCED HIGHWAY, COAST & ALPINE INFRASTRUCTURE (Guardrails, Lamps, Chevrons)
  // -------------------------------------------------------------------------
  const dummy = new THREE.Object3D();

  const railBeamMats: THREE.Matrix4[] = [];
  const railPostMats: THREE.Matrix4[] = [];
  const railReflMats: THREE.Matrix4[] = [];
  let guardrailColliderIndex = 0;

  for (const road of network.roads) {
    if (road.kind !== 'highway' && road.kind !== 'canyon' && road.kind !== 'coast') continue;
    const samples = road.samples;
    const step = road.kind === 'highway' ? 3 : 2;

    for (let i = 0; i < samples.length - step; i += step) {
      const a = samples[i];
      const b = samples[(i + step) % samples.length];

      // Skip inside Mountain Tunnel and across the Coastal Bridge (solid concrete walls/parapets already exist!).
      if (isInsideTunnelCoords(a.x, a.y + 1, a.z) || isInsideTunnelCoords(b.x, b.y + 1, b.z)) continue;
      if (isOnCoastBridgeSpan(a.x, a.z) || isOnCoastBridgeSpan(b.x, b.z)) continue;

      if (road.kind === 'highway') {
        if (Math.abs(a.z - 340) < 22 && (Math.abs(a.x) < 24 || Math.abs(a.x + 340) < 26 || Math.abs(a.x - 440) < 26)) continue;
        if (Math.abs(a.x + 575) < 30 && Math.abs(a.z - 175) < 28) continue;
        if (Math.abs(a.x - 165) < 30 && Math.abs(a.z + 620) < 26) continue;
        if (Math.abs(a.x + 520) < 35 && Math.abs(a.z + 565) < 30) continue;
      }

      const segLen = Math.hypot(b.x - a.x, b.z - a.z);
      if (segLen < 2 || segLen > 20) continue;

      const mx = (a.x + b.x) * 0.5;
      const my = (a.y + b.y) * 0.5;
      const mz = (a.z + b.z) * 0.5;
      const yaw = Math.atan2(b.x - a.x, b.z - a.z);
      const slopePitch = -Math.atan2(b.y - a.y, segLen);
      const lx = (b.z - a.z) / segLen;
      const lz = -(b.x - a.x) / segLen;

      const sides =
        road.kind === 'highway'
          ? [-1]
          : road.kind === 'coast'
            ? [1]
            : a.y > 7.5
              ? [-1, 1]
              : [];

      for (const side of sides) {
        const offset = (road.halfWidth + 0.9) * side;
        const rx = mx + lx * offset;
        const rz = mz + lz * offset;

        const q = network.query(rx, rz);
        if (q.onRoad) continue;

        dummy.position.set(rx, my + 0.64, rz);
        const beamYaw = side < 0 ? yaw : yaw + Math.PI;
        const beamPitch = side < 0 ? slopePitch : -slopePitch;
        dummy.rotation.set(beamPitch, beamYaw, 0, 'YXZ');
        dummy.scale.set(1, 1, segLen + 0.18);
        dummy.updateMatrix();
        railBeamMats.push(dummy.matrix.clone());

        for (const t of [0.0, 0.5]) {
          const px = lerp(a.x, b.x, t) + lx * (offset + side * 0.08);
          const py = lerp(a.y, b.y, t);
          const pz = lerp(a.z, b.z, t) + lz * (offset + side * 0.08);
          dummy.position.set(px, py, pz);
          dummy.rotation.set(0, yaw, 0);
          dummy.scale.set(1, 1, 1);
          dummy.updateMatrix();
          railPostMats.push(dummy.matrix.clone());

          if (t === 0.0) {
            dummy.position.set(px, py + 0.87, pz);
            dummy.rotation.set(0, yaw, 0);
            dummy.scale.set(1, 1, 1);
            dummy.updateMatrix();
            railReflMats.push(dummy.matrix.clone());
          }
        }

        addSolidBox(
          `guardrail-${guardrailColliderIndex++}`,
          'barrier',
          'metal',
          0.35,
          0.95,
          segLen + 0.1,
          rx,
          my + 0.48,
          rz,
          yaw,
        );
      }
    }
  }

  if (railBeamMats.length > 0) {
    const beamGeo = trackGeo(buildWBeamGuardrailGeometry());
    addChunkedInstances(group, beamGeo, guardrailBeamMat, 'inst-guardrail-beams', railBeamMats, null, {
      sectorSize: 360,
      castShadow: true,
      receiveShadow: true,
    });

    const postGeo = trackGeo(buildGuardrailPostGeometry());
    addChunkedInstances(group, postGeo, vertexMetalMat, 'inst-guardrail-posts', railPostMats, null, {
      sectorSize: 360,
      castShadow: false,
      receiveShadow: false,
      maxDistance: 280,
      cullList: cullableSectors,
    });

    const reflGeo = trackGeo(new THREE.BoxGeometry(0.06, 0.13, 0.09));
    addChunkedInstances(group, reflGeo, reflectorAmberMat, 'inst-guardrail-reflectors', railReflMats, null, {
      sectorSize: 400,
      castShadow: false,
      receiveShadow: false,
      maxDistance: 260,
      cullList: cullableSectors,
    });
  }

  // --- Canyon Pass Sharp-Turn Yellow/Black Chevron Signs & Roadside Delineator Posts ---
  const chevronSignMats: THREE.Matrix4[] = [];
  const chevronPostMats: THREE.Matrix4[] = [];
  const delineatorMats: THREE.Matrix4[] = [];

  for (const road of network.roads) {
    const samples = road.samples;
    if (road.kind === 'canyon') {
      let lastChevronIdx = -10;
      for (let i = 3; i < samples.length - 3; i++) {
        const prev = samples[i - 2];
        const curr = samples[i];
        const next = samples[i + 2];
        const lx = curr.tz;
        const lz = -curr.tx;

        // Signed left-turn strength: > 0 means turning left (+L), outside of curve is -L (right).
        const turnLeft = next.tx * lx + next.tz * lz - (prev.tx * lx + prev.tz * lz);
        if (Math.abs(turnLeft) > 0.24 && i - lastChevronIdx >= 4) {
          const outSide = turnLeft > 0 ? -1 : 1;
          const off = (road.halfWidth + 1.55) * outSide;
          const sx = curr.x + lx * off;
          const sz = curr.z + lz * off;
          const q = network.query(sx, sz);
          if (!q.onRoad && q.distance >= 0.9) {
            const sy = terrain.sampleHeight(sx, sz);
            // Face oncoming traffic (-T), tilted slightly toward roadway
            const faceYaw = curr.heading + Math.PI + outSide * 0.26;
            const roll = turnLeft > 0 ? Math.PI : 0; // flip arrow to point left on left turns, right on right turns

            dummy.position.set(sx, sy + 1.78, sz);
            dummy.rotation.set(0, faceYaw, roll, 'YXZ');
            dummy.scale.set(1, 1, 1);
            dummy.updateMatrix();
            chevronSignMats.push(dummy.matrix.clone());

            dummy.position.set(sx, sy, sz);
            dummy.rotation.set(0, faceYaw, 0);
            dummy.scale.set(1, 1, 1);
            dummy.updateMatrix();
            chevronPostMats.push(dummy.matrix.clone());
            lastChevronIdx = i;
          }
        }

        // Roadside flexible delineator posts along lower/shoulder stretches of Canyon Pass
        if (i % 9 === 0 && curr.y <= 3.8) {
          for (const side of [-1, 1]) {
            const off = (road.halfWidth + 1.45) * side;
            const dx = curr.x + lx * off;
            const dz = curr.z + lz * off;
            const q = network.query(dx, dz);
            if (!q.onRoad && q.distance >= 0.9) {
              dummy.position.set(dx, terrain.sampleHeight(dx, dz), dz);
              dummy.rotation.set(0, curr.heading, 0);
              dummy.scale.set(1, 1, 1);
              dummy.updateMatrix();
              delineatorMats.push(dummy.matrix.clone());
            }
          }
        }
      }
    } else if (road.kind === 'highway') {
      // Periodic white/amber delineator posts along inner highway verge (outer side has W-beam guardrails)
      for (let i = 0; i < samples.length; i += 10) {
        const curr = samples[i];
        const lx = curr.tz;
        const lz = -curr.tx;
        const off = road.halfWidth + 1.55; // inner (+1) edge
        const dx = curr.x + lx * off;
        const dz = curr.z + lz * off;
        const q = network.query(dx, dz);
        if (!q.onRoad && q.distance >= 1.0) {
          dummy.position.set(dx, terrain.sampleHeight(dx, dz), dz);
          dummy.rotation.set(0, curr.heading, 0);
          dummy.scale.set(1, 1, 1);
          dummy.updateMatrix();
          delineatorMats.push(dummy.matrix.clone());
        }
      }
    }
  }

  if (chevronSignMats.length > 0) {
    const chevBoardGeo = trackGeo(new THREE.PlaneGeometry(0.95, 1.15));
    chevBoardGeo.translate(0, 0, 0.015);
    addChunkedInstances(group, chevBoardGeo, chevronSignMat, 'inst-chevron-signs', chevronSignMats, null, {
      sectorSize: 2000,
      castShadow: false,
      receiveShadow: false,
    });

    const postStem = new THREE.BoxGeometry(0.08, 2.35, 0.08);
    postStem.translate(0, 0.92, -0.055);
    const signBack = new THREE.BoxGeometry(0.97, 1.17, 0.025);
    signBack.translate(0, 1.78, -0.005);
    const chevPostGeo = trackGeo(mergeColoredParts([postStem, signBack]));
    addChunkedInstances(group, chevPostGeo, steelGalvMat, 'inst-chevron-posts', chevronPostMats, null, {
      sectorSize: 2000,
      castShadow: false,
      receiveShadow: false,
    });
  }

  if (delineatorMats.length > 0) {
    const delinGeo = trackGeo(buildDelineatorPostGeometry());
    addChunkedInstances(group, delinGeo, vertexPolymerMat, 'inst-delineator-posts', delineatorMats, null, {
      sectorSize: 2000,
      castShadow: false,
      receiveShadow: false,
    });
  }

  // --- Tapered Galvanized Cobra-Head Streetlamps (spatially chunked, zero shadow pass) ---
  const lampTransforms: { x: number; y: number; z: number; yaw: number }[] = [];
  // 1.36 km Valley Expressway Straightaway (Z = 340)
  for (let x = -640; x <= 640; x += 56) {
    if (Math.abs(x) < 22 || Math.abs(x + 340) < 24 || Math.abs(x - 440) < 24) continue;
    lampTransforms.push({ x, y: terrain.sampleHeight(x, 329.0), z: 329.0, yaw: 0 });
    lampTransforms.push({ x, y: terrain.sampleHeight(x, 351.0), z: 351.0, yaw: Math.PI });
  }
  // Plaza South Boulevard
  for (let z = 82; z <= 310; z += 44) {
    lampTransforms.push({ x: -10.2, y: terrain.sampleHeight(-10.2, z), z, yaw: Math.PI / 2 });
    lampTransforms.push({ x: 10.2, y: terrain.sampleHeight(10.2, z), z, yaw: -Math.PI / 2 });
  }
  // Pacific Coast Steel-Arch Bridge lights
  for (let z = -108; z <= 108; z += 36) {
    lampTransforms.push({ x: COAST_BRIDGE_BOUNDS.centerX - 7.1, y: COAST_BRIDGE_BOUNDS.deckY, z, yaw: Math.PI / 2 });
    lampTransforms.push({ x: COAST_BRIDGE_BOUNDS.centerX + 7.1, y: COAST_BRIDGE_BOUNDS.deckY, z, yaw: -Math.PI / 2 });
  }
  // Airfield Crash Arena perimeter lights
  for (const x of [-490, -400, -310, -220]) {
    lampTransforms.push({ x, y: 0, z: 446, yaw: 0 });
    lampTransforms.push({ x, y: 0, z: 932, yaw: Math.PI });
  }

  if (lampTransforms.length > 0) {
    const lampGeos = buildCobraStreetlampGeometries();
    trackGeo(lampGeos.structure);
    trackGeo(lampGeos.lens);

    const lampMats: THREE.Matrix4[] = [];
    for (let i = 0; i < lampTransforms.length; i++) {
      const l = lampTransforms[i];
      dummy.position.set(l.x, l.y, l.z);
      dummy.rotation.set(0, l.yaw, 0);
      dummy.scale.set(1, 1, 1);
      dummy.updateMatrix();
      lampMats.push(dummy.matrix.clone());
    }
    addChunkedInstances(group, lampGeos.structure, vertexMetalMat, 'inst-lamp-structures', lampMats, null, {
      sectorSize: 400,
      castShadow: false,
      receiveShadow: false,
    });
    addChunkedInstances(group, lampGeos.lens, lampGlowMat, 'inst-lamp-lenses', lampMats, null, {
      sectorSize: 400,
      castShadow: false,
      receiveShadow: false,
    });
  }

  // Static reflective lane cones flanking airfield target runway (knockable cones are handled in dynamicProps.ts!).
  const conePositions: [number, number][] = [];
  for (let x = -480; x <= -240; x += 24) conePositions.push([x, 608.8], [x, 631.2]);

  if (conePositions.length > 0) {
    const coneGeo = trackGeo(buildTrafficConeGeometry());
    const coneMats: THREE.Matrix4[] = [];
    for (let i = 0; i < conePositions.length; i++) {
      const [x, z] = conePositions[i];
      dummy.position.set(x, 0, z);
      dummy.rotation.set(0, (i * 0.7) % (Math.PI * 2), 0);
      dummy.scale.set(1, 1, 1);
      dummy.updateMatrix();
      coneMats.push(dummy.matrix.clone());
    }
    addChunkedInstances(group, coneGeo, vertexPolymerMat, 'inst-traffic-cones', coneMats, null, {
      sectorSize: 360,
      castShadow: false,
      receiveShadow: false,
      maxDistance: 240,
      cullList: cullableSectors,
    });
  }

  // -------------------------------------------------------------------------
  // 6. MULTI-BIOME INSTANCED BOTANICAL TREES, JOSHUA TREES, GRASS, SHRUBS & BOULDERS
  // -------------------------------------------------------------------------
  const rand = seededRandom(4242);

  interface TreeTransform {
    x: number;
    y: number;
    z: number;
    sx: number;
    sy: number;
    yaw: number;
    leanX: number;
    leanZ: number;
    color: THREE.Color;
  }

  interface GroundTuft {
    x: number;
    y: number;
    z: number;
    sx: number;
    sy: number;
    yaw: number;
    color: THREE.Color;
  }

  interface BoulderTransform {
    x: number;
    y: number;
    z: number;
    sx: number;
    sy: number;
    sz: number;
    rx: number;
    ry: number;
    rz: number;
    color: THREE.Color;
  }

  const pineList: TreeTransform[] = [];
  const oakList: TreeTransform[] = [];
  const joshuaList: TreeTransform[] = [];
  const grassList: GroundTuft[] = [];
  const shrubList: GroundTuft[] = [];
  const boulderA: BoulderTransform[] = [];
  const boulderB: BoulderTransform[] = [];

  const isClearOfBuildings = (x: number, z: number): boolean => {
    if (x > -72 && x < 72 && z > -68 && z < 72) return false; // Blend Garage Plaza
    if (x > -552 && x < -128 && z > 428 && z < 952) return false; // Expanded Crash & Stunt Airfield
    if (x > -186 && x < -124 && z > 282 && z < 328) return false; // Service Station
    if (x > 240 && x < 290 && z > 228 && z < 262) return false; // East Warehouse
    if (x > -270 && x < -220 && z > 202 && z < 238) return false; // West Warehouse
    if (x > TUNNEL_BOUNDS.minX - 24 && x < TUNNEL_BOUNDS.maxX + 24 && Math.abs(z - TUNNEL_BOUNDS.centerZ) < 68) return false; // Tunnel cap/portals
    if (x < shorelineXAtZ(z) + 18) return false; // Keep Pacific Ocean & wet tidal sand clear of trees!
    return true;
  };

  const heroPines: readonly [number, number, number][] = [
    [-76, -42, 1.3], [-82, -22, 1.15], [-74, -58, 1.22],
    [76, -54, 1.28], [62, -74, 1.34], [34, -76, 1.18],
    [-28, -76, 1.32], [-48, -70, 1.14], [10, -82, 1.24],
    [-86, 52, 1.18], [62, 86, 1.14], [-52, 94, 1.08],
  ];
  const heroOaks: readonly [number, number, number][] = [
    [-78, 36, 1.18], [-72, 60, 1.08], [56, 74, 1.14],
    [-42, 78, 1.10], [-96, -12, 1.24], [32, 98, 1.14],
  ];

  const pinePalette = [0xcad4b8, 0xb6c6a2, 0xd4dab8, 0xa8b896, 0xc4cca8];
  const redwoodPalette = [0x9eb48c, 0x8ea67c, 0xb0c098, 0x829c74];
  const oakPalette = [0xd2d8b4, 0xbbc69e, 0xdbe0ba, 0xaeb992, 0xc8cfa8];
  const grassPalette = [0xe4d6a8, 0xd4c896, 0xc6be88, 0xeadcae, 0xbab882];
  const shrubPalette = [0x9aa688, 0x8a987b, 0xa9b092, 0x7e8d72, 0xb4b698];
  const rockPalette = [0xd6cdc0, 0xc4baa9, 0xdfd5c5, 0xb8afa2, 0xcec1ae];
  const redRockPalette = [0xc6744c, 0xb45e3c, 0xd48a5e, 0xa24e32, 0xc87f52];

  const makeTreeColor = (palette: readonly number[]) =>
    new THREE.Color(palette[Math.floor(rand() * palette.length)]).offsetHSL(
      (rand() - 0.5) * 0.025,
      (rand() - 0.5) * 0.06,
      (rand() - 0.5) * 0.06,
    );

  for (const [hx, hz, hs] of heroPines) {
    if (!isClearOfBuildings(hx, hz) || network.query(hx, hz).distance < 10.5) continue;
    pineList.push({
      x: hx,
      y: terrain.sampleHeight(hx, hz) - 0.15,
      z: hz,
      sx: hs * (0.94 + rand() * 0.14),
      sy: hs * (0.96 + rand() * 0.18),
      yaw: rand() * Math.PI * 2,
      leanX: (rand() - 0.5) * 0.05,
      leanZ: (rand() - 0.5) * 0.05,
      color: makeTreeColor(pinePalette),
    });
  }
  for (const [hx, hz, hs] of heroOaks) {
    if (!isClearOfBuildings(hx, hz) || network.query(hx, hz).distance < 11.5) continue;
    oakList.push({
      x: hx,
      y: terrain.sampleHeight(hx, hz) - 0.15,
      z: hz,
      sx: hs * (0.95 + rand() * 0.18),
      sy: hs * (0.90 + rand() * 0.16),
      yaw: rand() * Math.PI * 2,
      leanX: (rand() - 0.5) * 0.05,
      leanZ: (rand() - 0.5) * 0.05,
      color: makeTreeColor(oakPalette),
    });
  }

  // Scatter ~450 Coastal Pines & Towering Alpine Redwoods (heavily clustered in North-East Alpine biome & valley hills, skipping Desert!).
  for (let attempt = 0; attempt < 2600 && pineList.length < 450; attempt++) {
    const biasAlpine = attempt < 1100;
    const x = biasAlpine ? 110 + rand() * 940 : -760 + rand() * 1820;
    const z = biasAlpine ? -1020 + rand() * 940 : -1020 + rand() * 1980;
    if (!isClearOfBuildings(x, z)) continue;
    if (desertBiomeWeight(x, z) > 0.32) continue; // Keep pines out of red-rock desert
    const q = network.query(x, z);
    if (q.distance < 12.5) continue;
    const y = terrain.sampleHeight(x, z);
    if (y < OCEAN_LEVEL + 4.5 || y > 92) continue;

    const inAlpine = alpineBiomeWeight(x, z) > 0.35;
    const baseS = inAlpine ? 1.22 + rand() * 0.92 : 0.85 + rand() * 0.85;
    pineList.push({
      x,
      y: y - 0.25,
      z,
      sx: baseS * (0.88 + rand() * 0.24),
      sy: baseS * (inAlpine ? 1.05 + rand() * 0.35 : 0.92 + rand() * 0.28),
      yaw: rand() * Math.PI * 2,
      leanX: (rand() - 0.5) * 0.07,
      leanZ: (rand() - 0.5) * 0.07,
      color: makeTreeColor(inAlpine ? redwoodPalette : pinePalette),
    });
  }

  // Scatter ~185 California Live Oaks across coastal valley meadows & lower foothills (out of desert/ocean).
  for (let attempt = 0; attempt < 1300 && oakList.length < 185; attempt++) {
    const x = -740 + rand() * 1400;
    const z = -660 + rand() * 1300;
    if (!isClearOfBuildings(x, z)) continue;
    if (desertBiomeWeight(x, z) > 0.28 || alpineBiomeWeight(x, z) > 0.65) continue;
    const q = network.query(x, z);
    if (q.distance < 13.0) continue;
    const y = terrain.sampleHeight(x, z);
    if (y < OCEAN_LEVEL + 5.0 || y > 26) continue;
    const baseS = 0.88 + rand() * 0.78;
    oakList.push({
      x,
      y: y - 0.18,
      z,
      sx: baseS * (0.92 + rand() * 0.24),
      sy: baseS * (0.86 + rand() * 0.20),
      yaw: rand() * Math.PI * 2,
      leanX: (rand() - 0.5) * 0.06,
      leanZ: (rand() - 0.5) * 0.06,
      color: makeTreeColor(oakPalette),
    });
  }

  // Scatter ~95 Southwestern Desert Joshua Trees across the South-East Red-Rock Desert!
  for (let attempt = 0; attempt < 750 && joshuaList.length < 95; attempt++) {
    const x = 220 + rand() * 880;
    const z = 370 + rand() * 720;
    if (!isClearOfBuildings(x, z)) continue;
    if (desertBiomeWeight(x, z) < 0.35) continue;
    const q = network.query(x, z);
    if (q.distance < 11.5) continue;
    const y = terrain.sampleHeight(x, z);
    if (y > 24) continue; // Keep off vertical mesa cliff walls
    const baseS = 0.85 + rand() * 0.75;
    joshuaList.push({
      x,
      y: y - 0.15,
      z,
      sx: baseS,
      sy: baseS * (0.92 + rand() * 0.28),
      yaw: rand() * Math.PI * 2,
      leanX: (rand() - 0.5) * 0.08,
      leanZ: (rand() - 0.5) * 0.08,
      color: new THREE.Color(0x6f7c4f).offsetHSL((rand() - 0.5) * 0.03, 0, (rand() - 0.5) * 0.08),
    });
  }

  // Scatter ~220 sculpted boulders (stratified granite in Alpine/Coast, terracotta red-rock in Desert!).
  for (let attempt = 0; attempt < 1200 && boulderA.length + boulderB.length < 220; attempt++) {
    const x = -780 + rand() * 1840;
    const z = -1020 + rand() * 2040;
    if (!isClearOfBuildings(x, z)) continue;
    const q = network.query(x, z);
    if (q.distance < 9.5) continue;
    const y = terrain.sampleHeight(x, z);
    if (y < OCEAN_LEVEL + 1.5) continue;
    const inDesert = desertBiomeWeight(x, z) > 0.35;
    if (!inDesert && y < 3.0 && rand() < 0.65) continue;

    const base = 1.2 + rand() * 3.4;
    const sx = base * (0.85 + rand() * 0.65);
    const sy = base * (0.55 + rand() * 0.55);
    const sz = base * (0.85 + rand() * 0.65);
    const target = (boulderA.length + boulderB.length) % 2 === 0 ? boulderA : boulderB;
    const rCol = makeTreeColor(inDesert ? redRockPalette : rockPalette);
    target.push({
      x,
      y: y - sy * 0.34,
      z,
      sx,
      sy,
      sz,
      rx: (rand() - 0.5) * 0.4,
      ry: rand() * Math.PI * 2,
      rz: (rand() - 0.5) * 0.4,
      color: rCol,
    });
  }

  // Scatter ~380 California sagebrush & dry desert scrub shrubs (distance-culled at 260m).
  for (let attempt = 0; attempt < 1500 && shrubList.length < 380; attempt++) {
    const x = -760 + rand() * 1820;
    const z = -960 + rand() * 1940;
    if (!isClearOfBuildings(x, z)) continue;
    const q = network.query(x, z);
    if (q.distance < 5.0) continue;
    const y = terrain.sampleHeight(x, z);
    if (y < OCEAN_LEVEL + 4.0 || y > 58) continue;
    const s = 0.78 + rand() * 0.92;
    shrubList.push({
      x,
      y: y - 0.10,
      z,
      sx: s * (0.85 + rand() * 0.35),
      sy: s * (0.72 + rand() * 0.38),
      yaw: rand() * Math.PI * 2,
      color: makeTreeColor(shrubPalette),
    });
  }

  // Scatter ~820 coastal wild grass tufts along road verges & valley meadows (distance-culled at 220m).
  for (const road of network.roads) {
    const step = road.kind === 'canyon' || road.kind === 'coast' ? 3 : 4;
    for (let i = 0; i < road.samples.length && grassList.length < 520; i += step) {
      const s = road.samples[i];
      if (isOnCoastBridgeSpan(s.x, s.z) || isInsideTunnelCoords(s.x, s.y + 1, s.z)) continue;
      const lx = s.tz;
      const lz = -s.tx;
      for (const side of [-1, 1]) {
        if (rand() < 0.42) continue;
        const distOut = s.halfWidth + 4.4 + rand() * 9.5;
        const gx = s.x + lx * side * distOut + (rand() - 0.5) * 2.4;
        const gz = s.z + lz * side * distOut + (rand() - 0.5) * 2.4;
        if (!isClearOfBuildings(gx, gz)) continue;
        const q = network.query(gx, gz);
        if (q.onRoad || q.distance < 4.2) continue;
        const gy = terrain.sampleHeight(gx, gz);
        if (gy < OCEAN_LEVEL + 4.5 || gy > 68) continue;
        const sc = 0.82 + rand() * 0.8;
        grassList.push({
          x: gx,
          y: gy - 0.06,
          z: gz,
          sx: sc * (0.9 + rand() * 0.35),
          sy: sc * (0.8 + rand() * 0.45),
          yaw: rand() * Math.PI * 2,
          color: makeTreeColor(grassPalette),
        });
      }
    }
  }
  for (let attempt = 0; attempt < 700 && grassList.length < 820; attempt++) {
    const x = -720 + rand() * 1480;
    const z = -660 + rand() * 1380;
    if (!isClearOfBuildings(x, z)) continue;
    if (desertBiomeWeight(x, z) > 0.45) continue;
    const q = network.query(x, z);
    if (q.distance < 4.4) continue;
    const y = terrain.sampleHeight(x, z);
    if (y < OCEAN_LEVEL + 4.5 || y > 35) continue;
    const sc = 0.85 + rand() * 0.85;
    grassList.push({
      x,
      y: y - 0.06,
      z,
      sx: sc * (0.9 + rand() * 0.35),
      sy: sc * (0.8 + rand() * 0.45),
      yaw: rand() * Math.PI * 2,
      color: makeTreeColor(grassPalette),
    });
  }

  // --- Instantiate Coastal Pines & Redwoods (340m spatial sectors!) ---
  if (pineList.length > 0) {
    const pineGeos = buildCoastalPineGeometries();
    trackGeo(pineGeos.trunk);
    trackGeo(pineGeos.canopy);

    const pineMats: THREE.Matrix4[] = [];
    const pineColors: THREE.Color[] = [];
    for (let i = 0; i < pineList.length; i++) {
      const p = pineList[i];
      dummy.position.set(p.x, p.y, p.z);
      dummy.rotation.set(p.leanX, p.yaw, p.leanZ, 'YXZ');
      dummy.scale.set(p.sx, p.sy, p.sx);
      dummy.updateMatrix();
      pineMats.push(dummy.matrix.clone());
      pineColors.push(p.color);
    }

    addChunkedInstances(group, pineGeos.trunk, barkMat, 'inst-pine-trunks', pineMats, null, {
      sectorSize: 340,
      castShadow: true,
      receiveShadow: true,
    });
    addChunkedInstances(group, pineGeos.canopy, pineCanopyMat, 'inst-pine-canopy', pineMats, pineColors, {
      sectorSize: 340,
      castShadow: true,
      receiveShadow: false,
    });
  }

  // --- Instantiate California Live Oaks (340m spatial sectors!) ---
  if (oakList.length > 0) {
    const oakGeos = buildCaliforniaOakGeometries();
    trackGeo(oakGeos.trunk);
    trackGeo(oakGeos.canopy);

    const oakMats: THREE.Matrix4[] = [];
    const oakColors: THREE.Color[] = [];
    for (let i = 0; i < oakList.length; i++) {
      const o = oakList[i];
      dummy.position.set(o.x, o.y, o.z);
      dummy.rotation.set(o.leanX, o.yaw, o.leanZ, 'YXZ');
      dummy.scale.set(o.sx, o.sy, o.sx);
      dummy.updateMatrix();
      oakMats.push(dummy.matrix.clone());
      oakColors.push(o.color);
    }

    addChunkedInstances(group, oakGeos.trunk, barkMat, 'inst-oak-trunks', oakMats, null, {
      sectorSize: 340,
      castShadow: true,
      receiveShadow: true,
    });
    addChunkedInstances(group, oakGeos.canopy, oakCanopyMat, 'inst-oak-canopy', oakMats, oakColors, {
      sectorSize: 340,
      castShadow: true,
      receiveShadow: false,
    });
  }

  // --- Instantiate Desert Joshua Trees (lightweight forked silhouettes, zero shadow cost!) ---
  if (joshuaList.length > 0) {
    const jParts: THREE.BufferGeometry[] = [];
    const trunk = buildTaperedBranchTube(
      [new THREE.Vector3(0, 0, 0), new THREE.Vector3(0.08, 1.8, 0.04), new THREE.Vector3(-0.04, 3.4, -0.05)],
      [0.24, 0.19, 0.13],
      6,
      0.5,
      0.65,
      0.92,
    );
    jParts.push(trunk);
    const armSpecs: readonly [number, number, number, number][] = [
      [1.9, 0.9, 0.25, 3.6],
      [2.2, -0.85, 0.45, 3.8],
      [2.5, 0.15, -0.85, 4.1],
    ];
    for (const [startY, dx, dz, tipY] of armSpecs) {
      const arm = buildTaperedBranchTube(
        [
          new THREE.Vector3(0, startY, 0),
          new THREE.Vector3(dx * 0.85, startY + 0.25, dz * 0.85),
          new THREE.Vector3(dx, tipY, dz),
        ],
        [0.14, 0.11, 0.08],
        5,
        0.5,
        0.7,
        0.95,
      );
      jParts.push(arm);
      const tuft = new THREE.DodecahedronGeometry(0.42, 0);
      tuft.translate(dx, tipY + 0.18, dz);
      jParts.push(tintGeometry(tuft, 0x627044));
    }
    const topTuft = new THREE.DodecahedronGeometry(0.46, 0);
    topTuft.translate(-0.04, 3.62, -0.05);
    jParts.push(tintGeometry(topTuft, 0x627044));

    const joshuaGeo = trackGeo(mergeColoredParts(jParts));
    const joshuaMat = trackMat(new THREE.MeshLambertMaterial({ name: 'desert-joshua', vertexColors: true }));
    const jMats: THREE.Matrix4[] = [];
    const jCols: THREE.Color[] = [];
    for (let i = 0; i < joshuaList.length; i++) {
      const j = joshuaList[i];
      dummy.position.set(j.x, j.y, j.z);
      dummy.rotation.set(j.leanX, j.yaw, j.leanZ, 'YXZ');
      dummy.scale.set(j.sx, j.sy, j.sx);
      dummy.updateMatrix();
      jMats.push(dummy.matrix.clone());
      jCols.push(j.color);
    }
    addChunkedInstances(group, joshuaGeo, joshuaMat, 'inst-joshua-trees', jMats, jCols, {
      sectorSize: 360,
      castShadow: false,
      receiveShadow: true,
    });
  }

  // --- Instantiate Wild Coastal Grass Tufts & Sagebrush Shrubs (chunked + distance culled, zero shadows!) ---
  if (grassList.length > 0) {
    const grassGeo = trackGeo(buildGrassTuftGeometry());
    const grassMats: THREE.Matrix4[] = [];
    const grassColors: THREE.Color[] = [];
    for (let i = 0; i < grassList.length; i++) {
      const g = grassList[i];
      dummy.position.set(g.x, g.y, g.z);
      dummy.rotation.set(0, g.yaw, 0);
      dummy.scale.set(g.sx, g.sy, g.sx);
      dummy.updateMatrix();
      grassMats.push(dummy.matrix.clone());
      grassColors.push(g.color);
    }
    addChunkedInstances(group, grassGeo, grassTuftMat, 'inst-grass-tufts', grassMats, grassColors, {
      sectorSize: 320,
      castShadow: false,
      receiveShadow: false,
      maxDistance: 220,
      cullList: cullableSectors,
    });
  }

  if (shrubList.length > 0) {
    const shrubGeo = trackGeo(buildChaparralShrubGeometry());
    const shrubMats: THREE.Matrix4[] = [];
    const shrubColors: THREE.Color[] = [];
    for (let i = 0; i < shrubList.length; i++) {
      const s = shrubList[i];
      dummy.position.set(s.x, s.y, s.z);
      dummy.rotation.set(0, s.yaw, 0);
      dummy.scale.set(s.sx, s.sy, s.sx);
      dummy.updateMatrix();
      shrubMats.push(dummy.matrix.clone());
      shrubColors.push(s.color);
    }
    addChunkedInstances(group, shrubGeo, oakCanopyMat, 'inst-chaparral-shrubs', shrubMats, shrubColors, {
      sectorSize: 320,
      castShadow: false,
      receiveShadow: false,
      maxDistance: 260,
      cullList: cullableSectors,
    });
  }

  // --- Instantiate Stratified Alpine & Red-Rock Boulders (360m spatial sectors!) ---
  const addBoulderSet = (list: readonly BoulderTransform[], name: string, seed: number, angularity: number) => {
    if (list.length === 0) return;
    const rockGeo = trackGeo(buildSculptedBoulderGeometry(seed, angularity));
    const rockMats: THREE.Matrix4[] = [];
    const rockColors: THREE.Color[] = [];
    for (let i = 0; i < list.length; i++) {
      const b = list[i];
      dummy.position.set(b.x, b.y, b.z);
      dummy.rotation.set(b.rx, b.ry, b.rz);
      dummy.scale.set(b.sx, b.sy, b.sz);
      dummy.updateMatrix();
      rockMats.push(dummy.matrix.clone());
      rockColors.push(b.color);
    }
    addChunkedInstances(group, rockGeo, boulderMat, name, rockMats, rockColors, {
      sectorSize: 360,
      castShadow: true,
      receiveShadow: true,
    });
  };
  addBoulderSet(boulderA, 'inst-boulders-crag', 6101, 0.52);
  addBoulderSet(boulderB, 'inst-boulders-granite', 6209, 0.32);

  return { group, geometries, materials, colliders, cullableSectors };
}
