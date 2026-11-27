import * as THREE from 'three';
import { clamp, lerp, smoothstep } from '../math';
import { computeRoadBlend, isOnCoastBridgeSpan, type RoadNetwork } from './roads';
import type { WorldTextures } from './textures';
import { OCEAN_LEVEL, shorelineXAtZ } from './water';

export const WORLD_SIZE = 2400;
export const WORLD_HALF = WORLD_SIZE / 2;
/**
 * Grid resolution for both visual terrain mesh and physics heightfield:
 * 204x204 subdivisions (~11.76m cell spacing, 205x205 samples), divisible cleanly into 6x6 = 36 tiles!
 */
export const TERRAIN_SEGMENTS = 204;
/** Splits the 204x204 visual terrain into 6x6 (36) frustum-cullable seamless tiles (34x34 quads each). */
const TERRAIN_TILE_GRID = 6;

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

/** Iconic flat-topped Red-Rock Mesas & Buttes framing the South-East Desert Rally Loop (clear of dirt road!). */
const DESERT_MESAS: readonly { x: number; z: number; rx: number; rz: number; h: number }[] = [
  { x: 640, z: 715, rx: 105, rz: 82, h: 42 }, // Central Monument Mesa inside the Rally Loop!
  { x: 1030, z: 455, rx: 115, rz: 95, h: 52 },
  { x: 1045, z: 895, rx: 120, rz: 105, h: 56 },
  { x: 525, z: 1065, rx: 110, rz: 88, h: 48 },
  { x: 245, z: 970, rx: 95, rz: 80, h: 38 },
];

/** Returns 0..1 blend weight for the South-East Red-Rock Desert biome. */
export function desertBiomeWeight(x: number, z: number): number {
  const wx = smoothstep(140, 360, x);
  const wz = smoothstep(260, 480, z);
  return wx * wz;
}

/** Returns 0..1 blend weight for the North-East Redwood & Alpine Mountain biome. */
export function alpineBiomeWeight(x: number, z: number): number {
  const wx = smoothstep(60, 290, x);
  const wz = smoothstep(-60, -260, z);
  return wx * wz;
}

/**
 * Multi-Biome 2400x2400m California Base Terrain:
 * - West: Pacific Ocean seabed, golden sandy beaches, coastal bluffs & dramatic ocean bay inlet
 * - Center: Flat Motorsport Valley floor for Blend Garage HQ & 1.36 km Valley Expressway
 * - South-West: Flat Airfield Stunt Park & Crash Test Arena basin
 * - North-East: Dramatic Redwood & Alpine Mountain massif rising to +75..+115m
 * - South-East: Warm terracotta Desert Basin punctuated by flat-topped Red-Rock Sandstone Mesas
 * - North/East/South Perimeter: Layered ridged Sierra/coastal mountain range (West left open to Pacific Ocean!)
 */
function baseScenicHeight(x: number, z: number): number {
  const nBroad = fbm(x * 0.0021 + 4.1, z * 0.0021 - 2.7, 4);
  const nDetail = fbm(x * 0.0085 - 7.3, z * 0.0085 + 5.2, 3);
  const nRidge = ridgedFbm(x * 0.0016 + 1.8, z * 0.0016 - 3.4, 4);

  // 1. North-East Alpine Mountain Massif (peaks around (+560, -520) up to +95m).
  const dxAlp = (x - 540) / 480;
  const dzAlp = (z + 480) / 430;
  const alpRadial = Math.max(0, 1 - (dxAlp * dxAlp + dzAlp * dzAlp));
  const alpineHeight = alpRadial * alpRadial * (66 + nRidge * 44) + alpRadial * nBroad * 12;

  // 2. North Mountain Ridge framing the Sierra Ridge Tunnel (centered around (-20, -620)).
  const dxTun = (x + 20) / 310;
  const dzTun = (z + 650) / 210;
  const tunRadial = Math.max(0, 1 - (dxTun * dxTun + dzTun * dzTun));
  const tunnelFlankRidge = tunRadial * tunRadial * (42 + nRidge * 28);

  // 3. South-East Red-Rock Desert Mesas & rolling desert floor.
  let mesaHeight = 0;
  for (let i = 0; i < DESERT_MESAS.length; i++) {
    const m = DESERT_MESAS[i];
    const warp = fbm(x * 0.012 + i * 3.1, z * 0.012 - i * 2.7, 2) * 0.16;
    const d = Math.hypot((x - m.x) / m.rx, (z - m.z) / m.rz) + warp;
    if (d < 1.15) {
      // Steep terraced sandstone mesa walls flattening cleanly into a broad plateau top!
      const plateau = 1 - smoothstep(0.56, 1.05, d);
      const stepLedge = smoothstep(0.74, 0.86, 1 - d) * 0.16;
      const topRough = nDetail * 1.6;
      mesaHeight = Math.max(mesaHeight, (plateau + stepLedge * (1 - plateau)) * m.h + plateau * topRough);
    }
  }
  const desertRoll = desertBiomeWeight(x, z) * (2.5 + nBroad * 5.5 + nDetail * 1.4);

  // 4. Gentle California coastal valley foothills away from center.
  const valleyDist = Math.hypot(x + 80, z - 120);
  const gentleHills = smoothstep(320, 880, valleyDist) * (3.5 + nBroad * 8.5 + nDetail * 2.0);

  // 5. Outer Perimeter Mountain Rim (North, East, South only — keep West open to Pacific Ocean!).
  const northRim = smoothstep(-860, -1185, z);
  const southRim = smoothstep(890, 1185, z);
  const eastRim = smoothstep(880, 1185, x);
  const westOceanMask = smoothstep(-760, -560, x); // fades perimeter mountains cleanly before the Pacific Ocean
  const rimFactor = Math.max(eastRim, Math.max(northRim, southRim) * (0.25 + 0.75 * westOceanMask));
  const rimHeight = rimFactor * rimFactor * (46 + nRidge * 78 + Math.abs(nBroad) * 22 + nDetail * 5);

  let h = Math.max(0, alpineHeight + tunnelFlankRidge + mesaHeight + desertRoll + gentleHills + rimHeight);

  // 6. Western Pacific Coastline, Golden Beaches, Coastal Bluffs & Ocean Bay Inlet!
  const coastX = shorelineXAtZ(z);
  const distInland = x - coastX; // < 0 = ocean seabed, 0 = shoreline (-4m), > 0 = beach & bluffs

  if (distInland < 160) {
    // Gentle coastal bluff lift (+11..+16m) right behind the shoreline so Pacific Coast Hwy has dramatic ocean overlooks!
    const bluffBell = Math.exp(-Math.pow((distInland - 75) / 68, 2));
    const bluffElev = bluffBell * (12.5 + nBroad * 3.5);
    const landH = Math.max(h, bluffElev);

    if (distInland <= 0) {
      // Submerged seabed sloping cleanly down to -10m under Pacific Ocean water (y = -4m).
      const seaDepth = smoothstep(0, -120, distInland);
      h = lerp(OCEAN_LEVEL - 0.15, -10.5, seaDepth);
    } else {
      // Sandy beach & coastal cliff face rising from ocean waterline up to the bluffs.
      const rise = smoothstep(0, 72, distInland);
      const beachSlope = lerp(OCEAN_LEVEL - 0.15, landH, rise);
      h = lerp(beachSlope, landH, smoothstep(55, 160, distInland));
    }
  }

  // Deepen the coastal bay directly under the Steel-Arch Bridge so turquoise water fills the channel.
  if (isOnCoastBridgeSpan(x, z)) {
    const bayClear = 1 - smoothstep(75, 124, Math.abs(z));
    h = Math.min(h, lerp(h, -8.5, bayClear));
  }

  return h;
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
const _c10 = new THREE.Color();
const _c11 = new THREE.Color();

/**
 * Multi-biome California vertex coloring:
 * - West Coast: Golden sandy beaches & wet tidal sand fading into sunlit coastal bluffs
 * - Central Valley: Sun-cured golden oats, olive meadows, sagebrush & dusty road shoulders
 * - North-East Alpine: Rich conifer forest floor, mossy pine needles, exposed granite cliffs & sunlit peaks
 * - South-East Desert: Terracotta ochre sand, iron-oxide red-rock sandstone strata & dry desert mesas
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
  const cGraniteShadow = _c7.setHex(0x635d55);
  const cWarmPeak = _c8.setHex(0xaca08d);

  const macro = fbm(x * 0.0042 + 2.1, z * 0.0042 - 1.3, 3) * 0.5 + 0.5;
  const patch = fbm(x * 0.014 - 4.7, z * 0.014 + 6.3, 3) * 0.5 + 0.5;
  const micro = fbm(x * 0.036 + 9.2, z * 0.036 - 3.8, 2) * 0.5 + 0.5;

  // Base California coastal valley meadow.
  out.copy(cOliveMeadow).lerp(cGoldenGrass, smoothstep(0.28, 0.74, macro));
  out.lerp(cDryOat, smoothstep(0.52, 0.88, patch) * 0.52);
  out.lerp(cSageScrub, smoothstep(0.18, 0.55, micro) * 0.34);

  // --- North-East Redwood & Alpine Forest Biome ---
  const alpW = alpineBiomeWeight(x, z);
  if (alpW > 0.001) {
    const cPineFloor = _c10.setHex(0x475939);
    const cRedwoodDuff = _c11.setHex(0x6a5a42);
    cPineFloor.lerp(cRedwoodDuff, smoothstep(0.35, 0.78, patch) * 0.55);
    out.lerp(cPineFloor, alpW * 0.72);
  }

  // --- South-East Red-Rock Desert & Sandstone Mesa Biome ---
  const desW = desertBiomeWeight(x, z);
  if (desW > 0.001) {
    const cDesertSand = _c10.setHex(0xc89362);
    const cTerracotta = _c11.setHex(0xb4623e);
    cDesertSand.lerp(cTerracotta, smoothstep(0.32, 0.78, macro) * 0.65 + smoothstep(0.45, 0.85, patch) * 0.25);
    out.lerp(cDesertSand, desW * 0.94);
  }

  // Warm dusty earth along road verges & shoulders.
  if (shoulderBlend > 0.001) {
    const vergeCol = desW > 0.4 ? _c10.setHex(0xb67b50) : cDustyEarth;
    out.lerp(vergeCol, shoulderBlend * 0.72);
  }

  // Stratified cliff rock (red-rock iron-oxide strata in desert; warm sandstone/granite in alpine/canyon).
  const strataWave = Math.sin(y * 0.62 + fbm(x * 0.015, z * 0.015, 2) * 2.6) * 0.5 + 0.5;
  const rockTone = _c9.copy(cGraniteShadow).lerp(cSandstone, 0.35 + strataWave * 0.65);
  if (desW > 0.05) {
    const cRedCliff = _c10.setHex(0x8e4228).lerp(_c11.setHex(0xc77548), strataWave);
    rockTone.lerp(cRedCliff, desW * 0.92);
  }

  const slopeRock = smoothstep(0.07, 0.25, slope);
  const heightRock = smoothstep(32, 72, y) * 0.68;
  const rockMix = clamp(Math.max(slopeRock, heightRock), 0, 1);
  if (rockMix > 0.001) {
    out.lerp(rockTone, rockMix * 0.92);
  }

  // Sun-bleached granite crests on the highest Alpine peaks.
  const peakMix = smoothstep(66, 112, y);
  if (peakMix > 0.001) {
    out.lerp(cWarmPeak, peakMix * 0.52);
  }

  // --- West Coast Golden Sandy Beach & Wet Tidal Sand ---
  const coastDist = x - shorelineXAtZ(z);
  if (coastDist < 58 && y < 6.5) {
    const sandMix = (1 - smoothstep(14, 58, coastDist)) * (1 - smoothstep(2.0, 6.5, y));
    const cGoldenSand = _c10.setHex(0xd4be92);
    const cWetSand = _c11.setHex(0x8a795c);
    const wet = 1 - smoothstep(OCEAN_LEVEL + 0.2, OCEAN_LEVEL + 2.6, y);
    cGoldenSand.lerp(cWetSand, wet * 0.85);
    out.lerp(cGoldenSand, clamp(sandMix, 0, 1));
  }
}

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
 * Builds a purely visual outer distant mountain amphitheater (North, East & South horizons,
 * dipping below sea level on the West so the Pacific Ocean stretches unobstructed to the horizon!).
 */
function buildDistantMountainRing(material: THREE.Material): THREE.Mesh {
  const radialSegs = 96;
  const ringSegs = 5;
  const innerHalf = WORLD_HALF - 18;
  const outerHalf = 2150;

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

      // Keep the western ocean horizon (dx < -0.35) cleanly submerged beneath the Pacific Ocean plane!
      const oceanOpen = smoothstep(-0.22, -0.58, dx);

      let y: number;
      if (r === 0) {
        y = baseScenicHeight(x, z) - 1.8;
      } else {
        const ridge1 = ridgedFbm(x * 0.0012 + 3.2, z * 0.0012 - 2.1, 4);
        const ridge2 = ridgedFbm(x * 0.0028 - 5.4, z * 0.0028 + 4.8, 3);
        const crestEnvelope = Math.sin(t * Math.PI * 0.85);
        const baseEdge = baseScenicHeight(sqX, sqZ);
        const landPeak = lerp(baseEdge, 28 + ridge1 * 195 + ridge2 * 48, smoothstep(0.0, 0.35, t)) * (0.55 + crestEnvelope * 0.68);
        y = lerp(landPeak, -14, oceanOpen);
        if (r === rings - 1) y = Math.min(y, 14);
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
  /** Primary drivable 2400x2400m terrain container (36 frustum-cullable seamless tiles). */
  mesh: THREE.Object3D;
  /** Purely visual outer mountain amphitheater extending to the horizon (zero physics cost). */
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
 * Builds the 2400x2400m sculpted 6-biome California terrain partitioned into 6x6 (36) seamless
 * frustum-cullable tiles, plus the distant horizon mountain amphitheater and exact physics heightfield grid.
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

  // Compute seamless smooth normals across the entire 205x205 grid BEFORE splitting into 36 tiles.
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

  // Split visual terrain into 6x6 (36) seamless frustum-cullable tiles (~75% of terrain culled behind camera!).
  const tileSegs = segs / TERRAIN_TILE_GRID;
  const tileVertsPerSide = tileSegs + 1;
  const tileVertCount = tileVertsPerSide * tileVertsPerSide;

  // Shared index buffer layout for every 34x34 tile (Uint16 fits 35*35 = 1225 verts easily).
  const tileIndexTemplate = new Uint16Array(tileSegs * tileSegs * 6);
  let iPtr = 0;
  for (let lz = 0; lz < tileSegs; lz++) {
    for (let lx = 0; lx < tileSegs; lx++) {
      const a = lz * tileVertsPerSide + lx;
      const b = a + 1;
      const c = a + tileVertsPerSide;
      const d = c + 1;
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

          uvs[lIdx * 2] = x / 18;
          uvs[lIdx * 2 + 1] = z / 18;

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
