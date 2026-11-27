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

  // Base California coastal meadow: mix of olive-green valley floor and sun-cured golden grass.
  out.copy(cOliveMeadow).lerp(cGoldenGrass, smoothstep(0.28, 0.74, macro));
  out.lerp(cDryOat, smoothstep(0.52, 0.88, patch) * 0.55);
  out.lerp(cSageScrub, smoothstep(0.18, 0.55, micro) * 0.35);

  // Warm dusty earth along road verges & shoulders so roads blend organically into the landscape.
  if (shoulderBlend > 0.001) {
    out.lerp(cDustyEarth, shoulderBlend * 0.78);
  }

  // Elevation transition: drier golden-ochre foothills & exposed upper ridges.
  const foothillDry = smoothstep(5, 22, y);
  out.lerp(cDustyEarth, foothillDry * 0.36);

  // Stratified sandstone/granite cliff rock on steeper slopes & high canyon cuts.
  const strataWave = Math.sin(y * 0.72 + fbm(x * 0.018, z * 0.018, 2) * 2.4) * 0.5 + 0.5;
  const rockTone = _c9.copy(cGraniteShadow).lerp(cSandstone, 0.35 + strataWave * 0.65);

  const slopeRock = smoothstep(0.06, 0.24, slope);
  const heightRock = smoothstep(20, 48, y) * 0.72;
  const rockMix = clamp(Math.max(slopeRock, heightRock), 0, 1);
  if (rockMix > 0.001) {
    out.lerp(rockTone, rockMix * 0.92);
  }

  // Sun-bleached granite crests on the highest distant mountain peaks.
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
 * Builds a purely visual outer distant mountain range ring (from 585m out to 1080m) so the horizon
 * has multi-layered California Sierra/coastal silhouettes receding naturally into the golden haze.
 */
function buildDistantMountainRing(material: THREE.MeshStandardMaterial): THREE.Mesh {
  const radialSegs = 128;
  const ringSegs = 6;
  const innerHalf = WORLD_HALF - 14;
  const outerHalf = 1080;

  const rings = ringSegs + 1;
  const cols = radialSegs + 1;
  const positions = new Float32Array(rings * cols * 3);
  const uvs = new Float32Array(rings * cols * 2);
  const colors = new Float32Array(rings * cols * 3);
  const indices = new Uint32Array(ringSegs * radialSegs * 6);

  for (let r = 0; r < rings; r++) {
    const t = r / ringSegs;
    const radiusScale = lerp(innerHalf, outerHalf, t);
    for (let s = 0; s < cols; s++) {
      const ang = (s / radialSegs) * Math.PI * 2;
      const dx = Math.cos(ang);
      const dz = Math.sin(ang);

      // Map circle angle onto square perimeter at t=0 so the inner skirt joins the main terrain seamlessly,
      // then morphs smoothly into a circular distant mountain amphitheater.
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
        // Stitch slightly below the exact edge of the main terrain mesh.
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
      uvs[vi * 2] = x / 42;
      uvs[vi * 2 + 1] = z / 42;
    }
  }

  let ptr = 0;
  for (let r = 0; r < ringSegs; r++) {
    for (let s = 0; s < radialSegs; s++) {
      const a = r * cols + s;
      const b = r * cols + s + 1;
      const c = (r + 1) * cols + s;
      const d = (r + 1) * cols + s + 1;
      // Verified CCW upward (+Y) winding: (b - a) x (c - a) = (+Z) x (+X) = +Y.
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
  geo.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
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
    colors[i * 3] = tmp.r;
    colors[i * 3 + 1] = tmp.g;
    colors[i * 3 + 2] = tmp.b;
  }
  geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));

  const mesh = new THREE.Mesh(geo, material);
  mesh.name = 'distant-mountains';
  mesh.receiveShadow = false;
  mesh.castShadow = false;
  mesh.matrixAutoUpdate = false;
  return mesh;
}

export interface TerrainData {
  /** Primary drivable 1200x1200m terrain mesh. */
  mesh: THREE.Mesh;
  /** Purely visual outer mountain range ring extending to the horizon (zero physics cost). */
  distantMesh: THREE.Mesh;
  geometry: THREE.BufferGeometry;
  distantGeometry: THREE.BufferGeometry;
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
 * Builds the 1200x1200m sculpted California coastal valley terrain mesh, distant horizon mountain ring,
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
  const physicsHeights = new Float32Array(rows * cols);
  const shoulderWeights = new Float32Array(posAttr.count);

  for (let i = 0; i < posAttr.count; i++) {
    const x = posAttr.getX(i);
    const z = posAttr.getZ(i);

    const scenic = baseScenicHeight(x, z);
    const blend = computeRoadBlend(network, x, z);

    // Exact surface height for physics (matches roads & flat pads seamlessly).
    const physY = lerp(scenic, blend.targetY, blend.flattenWeight);

    // Visual terrain dips beneath paved roads & shoulder verges so 7.5m terrain triangles never poke through curved hills.
    const visualY = physY - blend.depressWeight * blend.depressDepth;
    posAttr.setY(i, visualY);

    const ix = clamp(Math.round(((x + WORLD_HALF) / WORLD_SIZE) * segs), 0, segs);
    const iz = clamp(Math.round(((z + WORLD_HALF) / WORLD_SIZE) * segs), 0, segs);
    physicsHeights[iz * cols + ix] = physY;
    shoulderWeights[i] = smoothstep(0.32, 0.92, blend.flattenWeight);

    // Tile detail UV every 16 meters (dual-scale shader breaks up repetition).
    uvAttr.setXY(i, x / 16, z / 16);
  }

  geometry.computeVertexNormals();

  // Compute rich California coastal biome vertex colors using exact computed surface slopes.
  const normAttr = geometry.attributes.normal as THREE.BufferAttribute;
  const colors = new Float32Array(posAttr.count * 3);
  const tmp = new THREE.Color();

  for (let i = 0; i < posAttr.count; i++) {
    const x = posAttr.getX(i);
    const y = posAttr.getY(i);
    const z = posAttr.getZ(i);
    const slope = 1 - clamp(normAttr.getY(i), 0, 1);

    evaluateCaliforniaBiomeColor(x, y, z, slope, shoulderWeights[i], tmp);
    colors[i * 3] = tmp.r;
    colors[i * 3 + 1] = tmp.g;
    colors[i * 3 + 2] = tmp.b;
  }
  geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));

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

  const mesh = new THREE.Mesh(geometry, material);
  mesh.name = 'terrain';
  mesh.receiveShadow = true;
  mesh.matrixAutoUpdate = false;

  const distantMesh = buildDistantMountainRing(material);

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
    distantMesh,
    geometry,
    distantGeometry: distantMesh.geometry,
    material,
    rows,
    cols,
    sizeX: WORLD_SIZE,
    sizeZ: WORLD_SIZE,
    physicsHeights,
    sampleHeight,
  };
}
