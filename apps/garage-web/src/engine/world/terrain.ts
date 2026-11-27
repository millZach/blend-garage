import * as THREE from 'three';
import { clamp, lerp, smoothstep } from '../math';
import { computeRoadBlend, type RoadNetwork } from './roads';
import type { WorldTextures } from './textures';

export const WORLD_SIZE = 1200;
export const WORLD_HALF = WORLD_SIZE / 2;
/** Grid resolution for both visual terrain mesh and physics heightfield (161x161 = 7.5m cell spacing). */
export const TERRAIN_SEGMENTS = 160;
/** Splits the 160x160 visual terrain into 4x4 (16) frustum-cullable seamless tiles (40x40 quads each). */
const TERRAIN_TILE_GRID = 4;

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

function fbm(x: number, z: number, octaves = 4): number {
  let v = 0;
  let amp = 0.55;
  let freq = 1;
  for (let i = 0; i < octaves; i++) {
    v += (valueNoise2D(x * freq, z * freq) * 2 - 1) * amp;
    freq *= 2.05;
    amp *= 0.48;
  }
  return v;
}

/** Ridged multifractal noise producing sharp, natural California coastal mountain crests & gullies. */
function ridgedFbm(x: number, z: number, octaves = 4): number {
  let sum = 0;
  let amp = 0.55;
  let freq = 1;
  let weight = 1;
  for (let i = 0; i < octaves; i++) {
    let n = 1 - Math.abs(valueNoise2D(x * freq, z * freq) * 2 - 1);
    n = n * n * weight;
    weight = clamp(n * 1.8, 0.25, 1.0);
    sum += n * amp;
    freq *= 2.08;
    amp *= 0.48;
  }
  return sum;
}

/**
 * Unflattened California coastal valley & canyon base terrain:
 * - Broad flat valley floor around Blend Garage Plaza, Proving Grounds & Highway straightaway
 * - Sculpted northwest canyon hills with natural sandstone outcrops
 * - Dramatic multi-layered ridged coastal mountain rim framing the horizon
 */
function baseScenicHeight(x: number, z: number): number {
  const nBroad = fbm(x * 0.0032 + 4.1, z * 0.0032 - 2.7, 4);
  const nDetail = fbm(x * 0.011 - 7.3, z * 0.011 + 5.2, 3);
  const nRidge = ridgedFbm(x * 0.0024 + 1.8, z * 0.0024 - 3.4, 4);

  // Northwest canyon hills rise around (-255, -115).
  const dxCanyon = (x + 255) / 185;
  const dzCanyon = (z + 115) / 170;
  const canyonMound = Math.max(0, 1 - (dxCanyon * dxCanyon + dzCanyon * dzCanyon));
  const canyonHeight = canyonMound * canyonMound * (22 + nRidge * 8) + canyonMound * nBroad * 6;

  // Scenic rolling coastal foothills in the valley outskirts.
  const valleyDist = Math.hypot(x - 40, z - 60);
  const gentleHills = smoothstep(160, 445, valleyDist) * (4.2 + nBroad * 7.2 + nDetail * 1.9);

  // Ridged coastal mountain range framing the perimeter (450m -> 600m).
  const edgeDist = Math.max(Math.abs(x), Math.abs(z));
  const rimFactor = smoothstep(450, 595, edgeDist);
  const rimHeight = rimFactor * rimFactor * (34 + nRidge * 62 + Math.abs(nBroad) * 18 + nDetail * 4);

  return Math.max(-0.4, canyonHeight + gentleHills + rimHeight);
}

/**
 * Applies California coastal biome coloring (golden wild grasses, olive sagebrush, dusty road verges,
 * and stratified warm sandstone/granite cliff rock) to a terrain vertex.
 */
function evaluateCaliforniaBiomeColor(
  x: number,
  y: number,
  z: number,
  slope: number,
  shoulderBlend: number,
  out: THREE.Color,
): void {
  const cGoldenGrass = _c1.setHex(0x9a8955);
  const cDryOat = _c2.setHex(0xb09d67);
  const cOliveMeadow = _c3.setHex(0x636f45);
  const cSageScrub = _c4.setHex(0x747c56);
  const cDustyEarth = _c5.setHex(0x948064);
  const cSandstone = _c6.setHex(0x8c7b66);
  const cGraniteShadow = _c7.setHex(0x655e55);
  const cWarmPeak = _c8.setHex(0xa89780);

  const macro = fbm(x * 0.0055 + 2.1, z * 0.0055 - 1.3, 3) * 0.5 + 0.5;
  const patch = fbm(x * 0.017 - 4.7, z * 0.017 + 6.3, 3) * 0.5 + 0.5;
  const micro = fbm(x * 0.045 + 9.2, z * 0.045 - 3.8, 2) * 0.5 + 0.5;

  out.copy(cOliveMeadow).lerp(cGoldenGrass, smoothstep(0.28, 0.74, macro));
  out.lerp(cDryOat, smoothstep(0.52, 0.88, patch) * 0.55);
  out.lerp(cSageScrub, smoothstep(0.18, 0.55, micro) * 0.35);

  if (shoulderBlend > 0.001) {
    out.lerp(cDustyEarth, shoulderBlend * 0.78);
  }

  const foothillDry = smoothstep(5, 22, y);
  out.lerp(cDustyEarth, foothillDry * 0.36);

  const strataWave = Math.sin(y * 0.72 + fbm(x * 0.018, z * 0.018, 2) * 2.4) * 0.5 + 0.5;
  const rockTone = _c9.copy(cGraniteShadow).lerp(cSandstone, 0.35 + strataWave * 0.65);

  const slopeRock = smoothstep(0.06, 0.24, slope);
  const heightRock = smoothstep(20, 48, y) * 0.72;
  const rockMix = clamp(Math.max(slopeRock, heightRock), 0, 1);
  if (rockMix > 0.001) {
    out.lerp(rockTone, rockMix * 0.92);
  }

  const peakMix = smoothstep(46, 92, y);
  if (peakMix > 0.001) {
    out.lerp(cWarmPeak, peakMix * 0.55);
  }
}

const _c1 = new THREE.Color();
const _c2 = new THREE.Color();
const _c3 = new THREE.Color();
const _c4 = new THREE.Color();
const _c5 = new THREE.Color();
const _c6 = new THREE.Color();
const _c7 = new THREE.Color();
const _c8 = new THREE.Color();
const _c9 = new THREE.Color();

/**
 * Adds dual-scale rotated detail sampling to eliminate visible texture tiling across wide hills.
 */
function enableDualScaleTerrainMaterial(material: THREE.MeshStandardMaterial): void {
  material.onBeforeCompile = (shader) => {
    shader.fragmentShader = shader.fragmentShader.replace(
      '#include <map_fragment>',
      /* glsl */ `
      #ifdef USE_MAP
        vec2 uvNear = vMapUv;
        mat2 rot37 = mat2(0.7986, -0.6018, 0.6018, 0.7986);
        vec2 uvFar = (rot37 * vMapUv) * 0.27 + vec2(0.37, 0.71);
        vec4 sNear = texture2D(map, uvNear);
        vec4 sFar = texture2D(map, uvFar);
        vec4 sampledDiffuseColor = mix(sNear, sFar, 0.44);
        diffuseColor *= sampledDiffuseColor;
      #endif
      `,
    );
  };
  material.customProgramCacheKey = () => 'california-terrain-dualscale-v1';
}

/**
 * Builds a purely visual outer distant mountain range ring (from 585m out to 1080m) using a
 * lightweight vertex-colored Lambert material (zero normal/roughness/shadow sampling in the haze).
 */
function buildDistantMountainRing(material: THREE.Material): THREE.Mesh {
  const radialSegs = 96;
  const ringSegs = 5;
  const innerHalf = WORLD_HALF - 14;
  const outerHalf = 1080;

  const rings = ringSegs + 1;
  const cols = radialSegs + 1;
  const positions = new Float32Array(rings * cols * 3);
  const colors = new Float32Array(rings * cols * 3);
  const indices = new Uint16Array(ringSegs * radialSegs * 6);

  for (let r = 0; r < rings; r++) {
    const t = r / ringSegs;
    const radiusScale = lerp(innerHalf, outerHalf, t);
    for (let s = 0; s < cols; s++) {
      const ang = (s / radialSegs) * Math.PI * 2;
      const dx = Math.cos(ang);
      const dz = Math.sin(ang);

      const maxAxis = Math.max(Math.abs(dx), Math.abs(dz)) || 1;
      const sqX = (dx / maxAxis) * innerHalf;
      const sqZ = (dz / maxAxis) * innerHalf;
      const circX = dx * radiusScale;
      const circZ = dz * radiusScale;

      const morph = smoothstep(0.0, 0.45, t);
      const x = lerp(sqX, circX, morph);
      const z = lerp(sqZ, circZ, morph);

      let y: number;
      if (r === 0) {
        y = baseScenicHeight(x, z) - 1.2;
      } else {
        const ridge1 = ridgedFbm(x * 0.0019 + 3.2, z * 0.0019 - 2.1, 4);
        const ridge2 = ridgedFbm(x * 0.0042 - 5.4, z * 0.0042 + 4.8, 3);
        const crestEnvelope = Math.sin(t * Math.PI * 0.85);
        const baseEdge = baseScenicHeight(sqX, sqZ);
        y = lerp(baseEdge, 18 + ridge1 * 128 + ridge2 * 36, smoothstep(0.0, 0.35, t)) * (0.55 + crestEnvelope * 0.65);
        if (r === rings - 1) y = Math.min(y, 12);
      }

      const vi = r * cols + s;
      positions[vi * 3] = x;
      positions[vi * 3 + 1] = y;
      positions[vi * 3 + 2] = z;
    }
  }

  let ptr = 0;
  for (let r = 0; r < ringSegs; r++) {
    for (let s = 0; s < radialSegs; s++) {
      const a = r * cols + s;
      const b = r * cols + s + 1;
      const c = (r + 1) * cols + s;
      const d = (r + 1) * cols + s + 1;
      indices[ptr++] = a;
      indices[ptr++] = b;
      indices[ptr++] = c;
      indices[ptr++] = b;
      indices[ptr++] = d;
      indices[ptr++] = c;
    }
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geo.setIndex(new THREE.BufferAttribute(indices, 1));
  geo.computeVertexNormals();

  const normAttr = geo.attributes.normal as THREE.BufferAttribute;
  const tmp = new THREE.Color();
  for (let i = 0; i < rings * cols; i++) {
    const x = positions[i * 3];
    const y = positions[i * 3 + 1];
    const z = positions[i * 3 + 2];
    const slope = 1 - clamp(Math.abs(normAttr.getY(i)), 0, 1);
    evaluateCaliforniaBiomeColor(x, y, z, slope, 0, tmp);
    // Match neutral terrainDetail luminance (~0.88) so the stitch line to the main terrain is invisible.
    colors[i * 3] = tmp.r * 0.88;
    colors[i * 3 + 1] = tmp.g * 0.88;
    colors[i * 3 + 2] = tmp.b * 0.88;
  }
  geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  geo.computeBoundingSphere();

  const mesh = new THREE.Mesh(geo, material);
  mesh.name = 'distant-mountains';
  mesh.receiveShadow = false;
  mesh.castShadow = false;
  mesh.matrixAutoUpdate = false;
  return mesh;
}

export interface TerrainData {
  /** Primary drivable 1200x1200m terrain container (16 frustum-cullable seamless tiles). */
  mesh: THREE.Object3D;
  /** Purely visual outer mountain range ring extending to the horizon (zero physics cost). */
  distantMesh: THREE.Mesh;
  /** All owned terrain tile geometries (for disposal). */
  geometries: THREE.BufferGeometry[];
  distantGeometry: THREE.BufferGeometry;
  material: THREE.MeshStandardMaterial;
  distantMaterial: THREE.Material;
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
 * Builds the 1200x1200m sculpted California coastal valley terrain partitioned into 4x4 seamless
 * frustum-cullable tiles, plus the distant horizon mountain ring and exact physics heightfield grid.
 */
export function buildTerrain(network: RoadNetwork, textures: WorldTextures): TerrainData {
  const segs = TERRAIN_SEGMENTS;
  const cols = segs + 1;
  const rows = segs + 1;
  const totalVerts = rows * cols;
  const cellStep = WORLD_SIZE / segs;

  const fullVisualY = new Float32Array(totalVerts);
  const physicsHeights = new Float32Array(totalVerts);
  const shoulderWeights = new Float32Array(totalVerts);

  for (let iz = 0; iz < rows; iz++) {
    const z = -WORLD_HALF + iz * cellStep;
    const rowOff = iz * cols;
    for (let ix = 0; ix < cols; ix++) {
      const x = -WORLD_HALF + ix * cellStep;
      const idx = rowOff + ix;

      const scenic = baseScenicHeight(x, z);
      const blend = computeRoadBlend(network, x, z);

      const physY = lerp(scenic, blend.targetY, blend.flattenWeight);
      const visualY = physY - blend.depressWeight * blend.depressDepth;

      physicsHeights[idx] = physY;
      fullVisualY[idx] = visualY;
      shoulderWeights[idx] = smoothstep(0.32, 0.92, blend.flattenWeight);
    }
  }

  // Compute seamless smooth normals across the entire 161x161 grid BEFORE splitting into tiles
  // so tile edges never show lighting seams.
  const fullNormals = new Float32Array(totalVerts * 3);
  const fullColors = new Float32Array(totalVerts * 3);
  const tmpColor = new THREE.Color();
  const twoStep = cellStep * 2;

  for (let iz = 0; iz < rows; iz++) {
    const z = -WORLD_HALF + iz * cellStep;
    const zm = Math.max(0, iz - 1);
    const zp = Math.min(rows - 1, iz + 1);
    const dzSpan = (zp - zm) * cellStep || twoStep;
    for (let ix = 0; ix < cols; ix++) {
      const x = -WORLD_HALF + ix * cellStep;
      const xm = Math.max(0, ix - 1);
      const xp = Math.min(cols - 1, ix + 1);
      const dxSpan = (xp - xm) * cellStep || twoStep;

      const idx = iz * cols + ix;
      const y = fullVisualY[idx];
      const dhdx = (fullVisualY[iz * cols + xp] - fullVisualY[iz * cols + xm]) / dxSpan;
      const dhdz = (fullVisualY[zp * cols + ix] - fullVisualY[zm * cols + ix]) / dzSpan;

      const invLen = 1 / Math.hypot(-dhdx, 1, -dhdz);
      const nx = -dhdx * invLen;
      const ny = invLen;
      const nz = -dhdz * invLen;

      fullNormals[idx * 3] = nx;
      fullNormals[idx * 3 + 1] = ny;
      fullNormals[idx * 3 + 2] = nz;

      const slope = 1 - clamp(ny, 0, 1);
      evaluateCaliforniaBiomeColor(x, y, z, slope, shoulderWeights[idx], tmpColor);
      fullColors[idx * 3] = tmpColor.r;
      fullColors[idx * 3 + 1] = tmpColor.g;
      fullColors[idx * 3 + 2] = tmpColor.b;
    }
  }

  const material = new THREE.MeshStandardMaterial({
    name: 'world-terrain',
    vertexColors: true,
    map: textures.terrainDetail,
    normalMap: textures.terrainNormal,
    normalScale: new THREE.Vector2(0.85, 0.85),
    roughnessMap: textures.terrainRough,
    roughness: 1.0,
    metalness: 0.0,
  });
  enableDualScaleTerrainMaterial(material);

  // Split visual terrain into 4x4 seamless frustum-cullable tiles (~65% of terrain culled behind camera!).
  const tileSegs = segs / TERRAIN_TILE_GRID;
  const tileVertsPerSide = tileSegs + 1;
  const tileVertCount = tileVertsPerSide * tileVertsPerSide;

  // Shared index buffer layout for every 40x40 tile (Uint16 fits 41*41 = 1681 verts easily).
  const tileIndexTemplate = new Uint16Array(tileSegs * tileSegs * 6);
  let iPtr = 0;
  for (let lz = 0; lz < tileSegs; lz++) {
    for (let lx = 0; lx < tileSegs; lx++) {
      const a = lz * tileVertsPerSide + lx;
      const b = a + 1;
      const c = a + tileVertsPerSide;
      const d = c + 1;
      // Verified +Y upward CCW winding: (c - a) x (b - a) = (+Z) x (+X) = +Y.
      tileIndexTemplate[iPtr++] = a;
      tileIndexTemplate[iPtr++] = c;
      tileIndexTemplate[iPtr++] = b;
      tileIndexTemplate[iPtr++] = b;
      tileIndexTemplate[iPtr++] = c;
      tileIndexTemplate[iPtr++] = d;
    }
  }

  const terrainGroup = new THREE.Group();
  terrainGroup.name = 'terrain';
  terrainGroup.matrixAutoUpdate = false;
  const geometries: THREE.BufferGeometry[] = [];

  for (let tz = 0; tz < TERRAIN_TILE_GRID; tz++) {
    for (let tx = 0; tx < TERRAIN_TILE_GRID; tx++) {
      const positions = new Float32Array(tileVertCount * 3);
      const normals = new Float32Array(tileVertCount * 3);
      const uvs = new Float32Array(tileVertCount * 2);
      const colors = new Float32Array(tileVertCount * 3);

      const startX = tx * tileSegs;
      const startZ = tz * tileSegs;

      for (let lz = 0; lz < tileVertsPerSide; lz++) {
        const gz = startZ + lz;
        const z = -WORLD_HALF + gz * cellStep;
        for (let lx = 0; lx < tileVertsPerSide; lx++) {
          const gx = startX + lx;
          const x = -WORLD_HALF + gx * cellStep;

          const gIdx = gz * cols + gx;
          const lIdx = lz * tileVertsPerSide + lx;

          positions[lIdx * 3] = x;
          positions[lIdx * 3 + 1] = fullVisualY[gIdx];
          positions[lIdx * 3 + 2] = z;

          normals[lIdx * 3] = fullNormals[gIdx * 3];
          normals[lIdx * 3 + 1] = fullNormals[gIdx * 3 + 1];
          normals[lIdx * 3 + 2] = fullNormals[gIdx * 3 + 2];

          uvs[lIdx * 2] = x / 16;
          uvs[lIdx * 2 + 1] = z / 16;

          colors[lIdx * 3] = fullColors[gIdx * 3];
          colors[lIdx * 3 + 1] = fullColors[gIdx * 3 + 1];
          colors[lIdx * 3 + 2] = fullColors[gIdx * 3 + 2];
        }
      }

      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
      geo.setAttribute('normal', new THREE.BufferAttribute(normals, 3));
      geo.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
      geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
      geo.setIndex(new THREE.BufferAttribute(tileIndexTemplate, 1));
      geo.computeBoundingBox();
      geo.computeBoundingSphere();
      geometries.push(geo);

      const tileMesh = new THREE.Mesh(geo, material);
      tileMesh.name = `terrain-tile-${tx}-${tz}`;
      tileMesh.castShadow = false;
      tileMesh.receiveShadow = true;
      tileMesh.matrixAutoUpdate = false;
      terrainGroup.add(tileMesh);
    }
  }

  // Lightweight non-shadowed Lambert material for distant horizon mountains in aerial perspective fog.
  const distantMaterial = new THREE.MeshLambertMaterial({
    name: 'world-distant-mountains',
    vertexColors: true,
  });
  const distantMesh = buildDistantMountainRing(distantMaterial);

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
    mesh: terrainGroup,
    distantMesh,
    geometries,
    distantGeometry: distantMesh.geometry,
    material,
    distantMaterial,
    rows,
    cols,
    sizeX: WORLD_SIZE,
    sizeZ: WORLD_SIZE,
    physicsHeights,
    sampleHeight,
  };
}
