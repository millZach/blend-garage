import * as THREE from 'three';
import { clamp, lerp, smoothstep } from '../math';
import { computeRoadBlend, type RoadNetwork } from './roads';
import type { WorldTextures } from './textures';

export const WORLD_SIZE = 1200;
export const WORLD_HALF = WORLD_SIZE / 2;
/** Grid resolution for both visual terrain mesh and physics heightfield (161x161 = 7.5m cell spacing). */
export const TERRAIN_SEGMENTS = 160;

function hash2(ix: number, iz: number): number {
  let n = Math.imul(ix, 374761393) + Math.imul(iz, 668265263);
  n = (n ^ (n >>> 13)) >>> 0;
  n = Math.imul(n, 1274126177) >>> 0;
  return ((n ^ (n >>> 16)) >>> 0) / 4294967296;
}

function valueNoise2D(x: number, z: number): number {
  const ix = Math.floor(x);
  const iz = Math.floor(z);
  const fx = x - ix;
  const fz = z - iz;
  const ux = fx * fx * (3 - 2 * fx);
  const uz = fz * fz * (3 - 2 * fz);
  const a = hash2(ix, iz);
  const b = hash2(ix + 1, iz);
  const c = hash2(ix, iz + 1);
  const d = hash2(ix + 1, iz + 1);
  return lerp(lerp(a, b, ux), lerp(c, d, ux), uz);
}

function fbm(x: number, z: number): number {
  let v = 0;
  let amp = 0.55;
  let freq = 1;
  for (let i = 0; i < 4; i++) {
    v += (valueNoise2D(x * freq, z * freq) * 2 - 1) * amp;
    freq *= 2.05;
    amp *= 0.48;
  }
  return v;
}

/**
 * Unflattened scenic base terrain: flat central valley around plaza/proving grounds,
 * rolling hills in the northwest canyon zone, and dramatic outer mountain rim framing the horizon.
 */
function baseScenicHeight(x: number, z: number): number {
  const nBroad = fbm(x * 0.0032 + 4.1, z * 0.0032 - 2.7);
  const nDetail = fbm(x * 0.011 - 7.3, z * 0.011 + 5.2);

  // Northwest canyon hills rise around (-250, -120).
  const dxCanyon = (x + 255) / 185;
  const dzCanyon = (z + 115) / 170;
  const canyonMound = Math.max(0, 1 - (dxCanyon * dxCanyon + dzCanyon * dzCanyon));
  const canyonHeight = canyonMound * canyonMound * 24 + canyonMound * nBroad * 8;

  // Scenic rolling meadow hills in the far northeast & southwest quadrants.
  const valleyDist = Math.hypot(x - 40, z - 60);
  const gentleHills = smoothstep(160, 440, valleyDist) * (4.5 + nBroad * 7.5 + nDetail * 1.8);

  // Mountain rim framing the outer boundary (from 470m out to 600m edge).
  const edgeDist = Math.max(Math.abs(x), Math.abs(z));
  const rimFactor = smoothstep(455, 595, edgeDist);
  const rimHeight = rimFactor * rimFactor * (44 + Math.abs(nBroad) * 34 + nDetail * 5);

  return Math.max(-0.4, canyonHeight + gentleHills + rimHeight);
}

export interface TerrainData {
  /** Mesh ready to add to the scene. */
  mesh: THREE.Mesh;
  geometry: THREE.BufferGeometry;
  material: THREE.MeshStandardMaterial;
  /** Number of vertices along X and Z (TERRAIN_SEGMENTS + 1). */
  rows: number;
  cols: number;
  /** World span in meters (WORLD_SIZE). */
  sizeX: number;
  sizeZ: number;
  /**
   * Exact driveable physics heights indexed `[iz * cols + ix]` where
   * `x = -WORLD_HALF + (ix / (cols - 1)) * WORLD_SIZE`,
   * `z = -WORLD_HALF + (iz / (rows - 1)) * WORLD_SIZE`.
   */
  physicsHeights: Float32Array;
  /** Evaluates exact physics ground height at any world (x, z) using bilinear interpolation on the grid. */
  sampleHeight(x: number, z: number): number;
}

/**
 * Builds the 1200x1200m sculpted terrain mesh (vertex-colored grass/dirt/rock/peak)
 * and matching exact physics heightfield grid.
 */
export function buildTerrain(network: RoadNetwork, textures: WorldTextures): TerrainData {
  const segs = TERRAIN_SEGMENTS;
  const cols = segs + 1;
  const rows = segs + 1;

  const geometry = new THREE.PlaneGeometry(WORLD_SIZE, WORLD_SIZE, segs, segs);
  geometry.rotateX(-Math.PI / 2);

  const posAttr = geometry.attributes.position as THREE.BufferAttribute;
  const uvAttr = geometry.attributes.uv as THREE.BufferAttribute;
  const colors = new Float32Array(posAttr.count * 3);
  const physicsHeights = new Float32Array(rows * cols);

  const cGrassLow = new THREE.Color(0x5f7e43);
  const cGrassDry = new THREE.Color(0x7c864b);
  const cDirt = new THREE.Color(0x8a795d);
  const cRock = new THREE.Color(0x75726b);
  const cPeak = new THREE.Color(0x9a978f);
  const cShoulder = new THREE.Color(0x6f6c64);
  const tmp = new THREE.Color();

  // PlaneGeometry rotated -PI/2 around X orders vertices from Z = -HALF..+HALF (row iz) and X = -HALF..+HALF (col ix).
  for (let i = 0; i < posAttr.count; i++) {
    const x = posAttr.getX(i);
    const z = posAttr.getZ(i);

    const scenic = baseScenicHeight(x, z);
    const blend = computeRoadBlend(network, x, z);

    // Exact surface height for physics (matches roads & flat pads seamlessly).
    const physY = lerp(scenic, blend.targetY, blend.flattenWeight);

    // Visual terrain dips 0.14m strictly under paved roads/pads to eliminate any Z-fighting.
    const visualY = physY - blend.depressWeight * 0.14;
    posAttr.setY(i, visualY);

    // Map into [iz * cols + ix] grid.
    const ix = clamp(Math.round(((x + WORLD_HALF) / WORLD_SIZE) * segs), 0, segs);
    const iz = clamp(Math.round(((z + WORLD_HALF) / WORLD_SIZE) * segs), 0, segs);
    physicsHeights[iz * cols + ix] = physY;

    // Tile detail UV every 18 meters.
    uvAttr.setXY(i, x / 18, z / 18);

    // Biome vertex coloring: lush valley grass, warm dry hillsides, rocky slopes & mountain peaks.
    const patch = fbm(x * 0.014, z * 0.014) * 0.5 + 0.5;
    tmp.copy(cGrassLow).lerp(cGrassDry, smoothstep(0.25, 0.78, patch));

    // Dirt/gravel road shoulders.
    const shoulderBlend = smoothstep(0.35, 0.92, blend.flattenWeight);
    tmp.lerp(cShoulder, shoulderBlend * 0.65);

    // Rocky canyon hillsides & high mountain rim.
    const rockHeight = smoothstep(10, 26, physY);
    tmp.lerp(cDirt, smoothstep(6, 15, physY) * 0.45);
    tmp.lerp(cRock, rockHeight * 0.85);
    tmp.lerp(cPeak, smoothstep(32, 56, physY) * 0.7);

    colors[i * 3] = tmp.r;
    colors[i * 3 + 1] = tmp.g;
    colors[i * 3 + 2] = tmp.b;
  }

  geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  geometry.computeVertexNormals();

  // Darken steep slopes toward rock color using computed vertex normals.
  const normAttr = geometry.attributes.normal as THREE.BufferAttribute;
  const colorAttr = geometry.attributes.color as THREE.BufferAttribute;
  for (let i = 0; i < posAttr.count; i++) {
    const ny = normAttr.getY(i);
    const slope = 1 - clamp(ny, 0, 1);
    const rockMix = smoothstep(0.08, 0.28, slope);
    if (rockMix > 0.001) {
      tmp.setRGB(colorAttr.getX(i), colorAttr.getY(i), colorAttr.getZ(i)).lerp(cRock, rockMix * 0.8);
      colorAttr.setXYZ(i, tmp.r, tmp.g, tmp.b);
    }
  }
  colorAttr.needsUpdate = true;

  const material = new THREE.MeshStandardMaterial({
    name: 'world-terrain',
    vertexColors: true,
    map: textures.terrainDetail,
    roughness: 0.94,
    metalness: 0.0,
  });

  const mesh = new THREE.Mesh(geometry, material);
  mesh.name = 'terrain';
  mesh.receiveShadow = true;
  mesh.matrixAutoUpdate = false;

  const sampleHeight = (x: number, z: number): number => {
    const u = clamp((x + WORLD_HALF) / WORLD_SIZE, 0, 1) * segs;
    const v = clamp((z + WORLD_HALF) / WORLD_SIZE, 0, 1) * segs;
    const ix0 = Math.min(segs - 1, Math.floor(u));
    const iz0 = Math.min(segs - 1, Math.floor(v));
    const fx = u - ix0;
    const fz = v - iz0;
    const h00 = physicsHeights[iz0 * cols + ix0];
    const h10 = physicsHeights[iz0 * cols + ix0 + 1];
    const h01 = physicsHeights[(iz0 + 1) * cols + ix0];
    const h11 = physicsHeights[(iz0 + 1) * cols + ix0 + 1];
    return lerp(lerp(h00, h10, fx), lerp(h01, h11, fx), fz);
  };

  return {
    mesh,
    geometry,
    material,
    rows,
    cols,
    sizeX: WORLD_SIZE,
    sizeZ: WORLD_SIZE,
    physicsHeights,
    sampleHeight,
  };
}
