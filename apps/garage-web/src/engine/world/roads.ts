import * as THREE from 'three';
import type { Vec3 } from '@blend-garage/vehicle-core';
import { clamp, smoothstep } from '../math';
import { MeshBatcher } from '../MeshBatcher';
import type { WorldTextures } from './textures';

export type SpawnName = 'start' | 'highway' | 'proving-grounds' | 'canyon';

export interface WorldSpawnPose {
  name?: SpawnName;
  label?: string;
  /** World-space floor position [x, y, z] matching `@blend-garage/world-racing` Vec3. */
  position: Vec3;
  /** Yaw in radians around +Y; 0 faces +Z, +PI/2 faces +X. */
  headingRad: number;
}

export interface RoadSample {
  x: number;
  y: number;
  z: number;
  tx: number;
  tz: number;
  heading: number;
  halfWidth: number;
  bankRad: number;
  roadId: string;
}

export interface FlatPad {
  id: string;
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
  y: number;
  blendMargin: number;
}

export interface RoadDefinition {
  id: string;
  kind: 'highway' | 'canyon' | 'connector';
  closed: boolean;
  halfWidth: number;
  samples: RoadSample[];
}

export interface RoadQueryResult {
  distance: number;
  roadY: number;
  halfWidth: number;
  onRoad: boolean;
  sample: RoadSample | null;
}

/** Flat paved zones: Spawn Plaza & Crash-Test/Stunt Proving Grounds. */
export const FLAT_PADS: readonly FlatPad[] = [
  {
    id: 'garage-plaza',
    minX: -54,
    maxX: 54,
    minZ: -52,
    maxZ: 54,
    y: 0,
    blendMargin: 18,
  },
  {
    id: 'proving-grounds',
    minX: 74,
    maxX: 242,
    minZ: -78,
    maxZ: 124,
    y: 0,
    blendMargin: 20,
  },
];

interface RoadControlSpec {
  id: string;
  kind: 'highway' | 'canyon' | 'connector';
  closed: boolean;
  halfWidth: number;
  spacing: number;
  points: readonly [number, number, number][];
}

const ROAD_SPECS: readonly RoadControlSpec[] = [
  // 1. Main 4-lane Highway Loop (~2.2 km) with dead-flat 620m South Top-Speed Straightaway at Z = +260.
  {
    id: 'highway-loop',
    kind: 'highway',
    closed: true,
    halfWidth: 8.5,
    spacing: 3.5,
    points: [
      [-310, 0, 260],
      [-155, 0, 260],
      [0, 0, 260],
      [155, 0, 260],
      [310, 0, 260],
      [395, 0, 200],
      [420, 1.0, 60],
      [415, 2.5, -100],
      [345, 3.2, -230],
      [215, 3.8, -285],
      [60, 4.4, -300],
      [-100, 4.0, -290],
      [-260, 5.2, -245],
      [-375, 3.6, -135],
      [-405, 1.6, 15],
      [-385, 0.3, 165],
    ],
  },
  // 2. Straight Plaza-to-Highway Connector Boulevard along X = 0 (from Plaza Z = 44 to Highway Z = 264).
  {
    id: 'plaza-highway-connector',
    kind: 'connector',
    closed: false,
    halfWidth: 7.2,
    spacing: 3.0,
    points: [
      [0, 0, 44],
      [0, 0, 115],
      [0, 0, 190],
      [0, 0, 264],
    ],
  },
  // 3. Direct Plaza-to-Proving-Grounds Access Boulevard along Z = +20.
  {
    id: 'plaza-proving-connector',
    kind: 'connector',
    closed: false,
    halfWidth: 7.5,
    spacing: 2.5,
    points: [
      [46, 0, 20],
      [64, 0, 20],
      [82, 0, 20],
    ],
  },
  // 4. Proving Grounds South Exit linking cleanly into Highway South Straightaway (X = 160, Z = 116 -> 264).
  {
    id: 'proving-highway-connector',
    kind: 'connector',
    closed: false,
    halfWidth: 6.5,
    spacing: 3.0,
    points: [
      [160, 0, 116],
      [160, 0, 190],
      [160, 0, 264],
    ],
  },
  // 5. Winding Hillside / Canyon Pass — sweeping S-curves climbing up to +16m elevation and joining the Highway Loop.
  {
    id: 'canyon-pass',
    kind: 'canyon',
    closed: false,
    halfWidth: 5.8,
    spacing: 3.0,
    points: [
      [-46, 0, 8],
      [-105, 1.2, 8],
      [-165, 5.0, -32],
      [-235, 10.5, -18],
      [-290, 15.2, -78],
      [-235, 16.0, -155],
      [-275, 11.2, -215],
      [-260, 5.2, -248],
    ],
  },
  // 6. Canyon South Spur linking the Canyon Pass down to the West Highway sweep.
  {
    id: 'canyon-west-spur',
    kind: 'canyon',
    closed: false,
    halfWidth: 5.5,
    spacing: 3.0,
    points: [
      [-235, 10.5, -18],
      [-295, 7.0, 35],
      [-345, 3.4, 22],
      [-405, 1.6, 15],
    ],
  },
];

function sampleRoadSpline(spec: RoadControlSpec): RoadDefinition {
  const vectors = spec.points.map(([x, y, z]) => new THREE.Vector3(x, y, z));
  const curve = new THREE.CatmullRomCurve3(vectors, spec.closed, 'centripetal', 0.5);
  const length = curve.getLength();
  const count = Math.max(12, Math.round(length / spec.spacing));

  const rawPoints: THREE.Vector3[] = [];
  for (let i = 0; i < (spec.closed ? count : count + 1); i++) {
    const u = spec.closed ? i / count : i / count;
    rawPoints.push(curve.getPointAt(u));
  }

  const samples: RoadSample[] = [];
  const n = rawPoints.length;
  for (let i = 0; i < n; i++) {
    const prev = rawPoints[(i - 1 + n) % n];
    const curr = rawPoints[i];
    const next = rawPoints[(i + 1) % n];

    const p0 = !spec.closed && i === 0 ? curr : prev;
    const p1 = !spec.closed && i === n - 1 ? curr : next;

    const dx = p1.x - p0.x;
    const dz = p1.z - p0.z;
    const len = Math.hypot(dx, dz) || 1;
    const tx = dx / len;
    const tz = dz / len;
    const heading = Math.atan2(tx, tz);

    // Subtle curvature-based banking on canyon turns (kept gentle <= 3.5 deg for predictable physics).
    let bankRad = 0;
    if (spec.kind === 'canyon' && i > 1 && i < n - 2) {
      const a = rawPoints[i - 1];
      const b = rawPoints[i + 1];
      const v1x = curr.x - a.x;
      const v1z = curr.z - a.z;
      const v2x = b.x - curr.x;
      const v2z = b.z - curr.z;
      const cross = v1x * v2z - v1z * v2x;
      const denom = (Math.hypot(v1x, v1z) * Math.hypot(v2x, v2z) + 1e-4) * spec.spacing;
      bankRad = clamp(cross / denom * 0.45, -0.055, 0.055);
    }

    samples.push({
      x: curr.x,
      y: curr.y,
      z: curr.z,
      tx,
      tz,
      heading,
      halfWidth: spec.halfWidth,
      bankRad,
      roadId: spec.id,
    });
  }

  return {
    id: spec.id,
    kind: spec.kind,
    closed: spec.closed,
    halfWidth: spec.halfWidth,
    samples,
  };
}

/** Distance from point (x, z) to an axis-aligned pad rectangle (0 if inside). */
function padDistance(pad: FlatPad, x: number, z: number): number {
  const dx = x < pad.minX ? pad.minX - x : x > pad.maxX ? x - pad.maxX : 0;
  const dz = z < pad.minZ ? pad.minZ - z : z > pad.maxZ ? z - pad.maxZ : 0;
  return Math.hypot(dx, dz);
}

/**
 * Spatial grid accelerating road distance & elevation queries across the 1200x1200m world.
 */
export class RoadNetwork {
  readonly roads: readonly RoadDefinition[];
  readonly allSamples: readonly RoadSample[];
  readonly spawnPoints: Record<SpawnName, WorldSpawnPose>;

  private readonly cellSize = 24;
  private readonly gridOrigin = -640;
  private readonly gridDim = 54;
  private readonly buckets: RoadSample[][];

  constructor() {
    this.roads = ROAD_SPECS.map(sampleRoadSpline);
    const all: RoadSample[] = [];
    for (const r of this.roads) {
      for (const s of r.samples) all.push(s);
    }
    this.allSamples = all;

    this.buckets = Array.from({ length: this.gridDim * this.gridDim }, () => []);
    for (const sample of all) {
      const gx = clamp(Math.floor((sample.x - this.gridOrigin) / this.cellSize), 0, this.gridDim - 1);
      const gz = clamp(Math.floor((sample.z - this.gridOrigin) / this.cellSize), 0, this.gridDim - 1);
      this.buckets[gz * this.gridDim + gx].push(sample);
    }

    // Compute exact canyon spawn on the uphill curve.
    const canyonRoad = this.roads.find((r) => r.id === 'canyon-pass')!;
    const canyonSample = canyonRoad.samples[Math.floor(canyonRoad.samples.length * 0.25)];

    this.spawnPoints = {
      start: {
        name: 'start',
        label: 'Garage Plaza',
        position: [0, 0.04, 0],
        headingRad: 0,
      },
      highway: {
        name: 'highway',
        label: 'Highway Straight',
        position: [-240, 0.04, 260],
        headingRad: Math.PI / 2,
      },
      'proving-grounds': {
        name: 'proving-grounds',
        label: 'Crash Proving Grounds',
        position: [96, 0.04, 20],
        headingRad: Math.PI / 2,
      },
      canyon: {
        name: 'canyon',
        label: 'Canyon Pass',
        position: [canyonSample.x, canyonSample.y + 0.04, canyonSample.z],
        headingRad: canyonSample.heading,
      },
    };
  }

  /** Queries distance to the nearest road or paved pad, plus the exact road surface elevation. */
  query(x: number, z: number): RoadQueryResult {
    let bestDist = Infinity;
    let bestY = 0;
    let bestHalfWidth = 0;
    let bestSample: RoadSample | null = null;
    let onRoad = false;

    for (const pad of FLAT_PADS) {
      const d = padDistance(pad, x, z);
      if (d <= 0) {
        return { distance: 0, roadY: pad.y, halfWidth: 0, onRoad: true, sample: null };
      }
      if (d < bestDist) {
        bestDist = d;
        bestY = pad.y;
        bestHalfWidth = 0;
      }
    }

    const gx = clamp(Math.floor((x - this.gridOrigin) / this.cellSize), 0, this.gridDim - 1);
    const gz = clamp(Math.floor((z - this.gridOrigin) / this.cellSize), 0, this.gridDim - 1);

    // Search a 5x5 cell window (~60m radius) for nearby road splines.
    for (let dz = -2; dz <= 2; dz++) {
      const iz = gz + dz;
      if (iz < 0 || iz >= this.gridDim) continue;
      for (let dx = -2; dx <= 2; dx++) {
        const ix = gx + dx;
        if (ix < 0 || ix >= this.gridDim) continue;
        const bucket = this.buckets[iz * this.gridDim + ix];
        for (let i = 0; i < bucket.length; i++) {
          const s = bucket[i];
          const centerDist = Math.hypot(x - s.x, z - s.z);
          const edgeDist = Math.max(0, centerDist - s.halfWidth);
          if (edgeDist < bestDist || (edgeDist === 0 && bestSample === null)) {
            bestDist = edgeDist;
            bestY = s.y;
            bestHalfWidth = s.halfWidth;
            bestSample = s;
            if (edgeDist === 0) onRoad = true;
          }
        }
      }
    }

    return {
      distance: bestDist,
      roadY: bestY,
      halfWidth: bestHalfWidth,
      onRoad,
      sample: bestSample,
    };
  }

  /** Returns the nearest clean asphalt pose aligned with the road tangent (for Reset-to-Road). */
  nearestRoadPose(x: number, z: number): WorldSpawnPose {
    // If already inside the Garage Plaza or Proving Grounds, reset upright on clean tarmac nearby.
    for (const pad of FLAT_PADS) {
      if (x >= pad.minX + 4 && x <= pad.maxX - 4 && z >= pad.minZ + 4 && z <= pad.maxZ - 4) {
        if (pad.id === 'garage-plaza') {
          return {
            name: 'start',
            label: 'Garage Plaza',
            position: [clamp(x, -36, 36), pad.y + 0.04, clamp(z, -16, 40)],
            headingRad: 0,
          };
        }
        return {
          name: 'proving-grounds',
          label: 'Crash Proving Grounds',
          position: [clamp(x, 86, 185), pad.y + 0.04, clamp(z, -60, 108)],
          headingRad: Math.PI / 2,
        };
      }
    }

    let best: RoadSample = this.allSamples[0];
    let bestD2 = Infinity;
    for (let i = 0; i < this.allSamples.length; i++) {
      const s = this.allSamples[i];
      const dx = x - s.x;
      const dz = z - s.z;
      const d2 = dx * dx + dz * dz;
      if (d2 < bestD2) {
        bestD2 = d2;
        best = s;
      }
    }

    return {
      position: [best.x, best.y + 0.04, best.z],
      headingRad: best.heading,
    };
  }
}

/**
 * Builds a single road ribbon BufferGeometry with tucked side skirts so edges seal cleanly into terrain.
 */
function buildRoadRibbonGeometry(road: RoadDefinition, tileMeters: number, yOffset: number): THREE.BufferGeometry {
  const samples = road.samples;
  const n = samples.length;
  const ringCount = road.closed ? n + 1 : n;
  const vertsPerRing = 4; // outerLeft, edgeLeft, edgeRight, outerRight

  const positions = new Float32Array(ringCount * vertsPerRing * 3);
  const normals = new Float32Array(ringCount * vertsPerRing * 3);
  const uvs = new Float32Array(ringCount * vertsPerRing * 2);

  let distAccum = 0;
  for (let i = 0; i < ringCount; i++) {
    const s = samples[i % n];
    if (i > 0) {
      const prev = samples[(i - 1) % n];
      distAccum += Math.hypot(s.x - prev.x, s.y - prev.y, s.z - prev.z);
    }

    // Left normal in horizontal plane: L = (+tz, 0, -tx) for T = (tx, 0, tz).
    const lx = s.tz;
    const lz = -s.tx;
    const hw = s.halfWidth;
    const skirtW = hw + 1.5;
    const y = s.y + yOffset;
    const vCoord = distAccum / tileMeters;

    const ringOffsets: readonly [number, number, number][] = [
      [skirtW, y - 0.42, 0.0],
      [hw, y, 0.075],
      [-hw, y, 0.925],
      [-skirtW, y - 0.42, 1.0],
    ];

    for (let k = 0; k < vertsPerRing; k++) {
      const [lat, py, uCoord] = ringOffsets[k];
      const vi = i * vertsPerRing + k;
      positions[vi * 3] = s.x + lx * lat;
      positions[vi * 3 + 1] = py;
      positions[vi * 3 + 2] = s.z + lz * lat;

      normals[vi * 3] = 0;
      normals[vi * 3 + 1] = 1;
      normals[vi * 3 + 2] = 0;

      uvs[vi * 2] = uCoord;
      uvs[vi * 2 + 1] = vCoord;
    }
  }

  const quadCount = (ringCount - 1) * (vertsPerRing - 1);
  const indices = new Uint32Array(quadCount * 6);
  let ptr = 0;
  for (let i = 0; i < ringCount - 1; i++) {
    for (let k = 0; k < vertsPerRing - 1; k++) {
      const a = i * vertsPerRing + k;
      const b = i * vertsPerRing + k + 1;
      const c = (i + 1) * vertsPerRing + k;
      const d = (i + 1) * vertsPerRing + k + 1;
      // Verified CCW upward winding: (a, b, c) and (b, d, c).
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
  geo.setAttribute('normal', new THREE.BufferAttribute(normals, 3));
  geo.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
  geo.setIndex(new THREE.BufferAttribute(indices, 1));
  geo.computeVertexNormals();
  return geo;
}

export interface RoadVisuals {
  group: THREE.Group;
  geometries: THREE.BufferGeometry[];
  materials: THREE.Material[];
}

/**
 * Builds all road ribbons, plaza tarmac, proving grounds apron, and painted runway markings.
 */
export function buildRoadVisuals(network: RoadNetwork, textures: WorldTextures): RoadVisuals {
  const group = new THREE.Group();
  group.name = 'world-roads';
  const geometries: THREE.BufferGeometry[] = [];
  const materials: THREE.Material[] = [];

  const highwayMat = new THREE.MeshStandardMaterial({
    name: 'highway-asphalt',
    map: textures.highwayRoad,
    normalMap: textures.asphaltNormal,
    normalScale: new THREE.Vector2(0.35, 0.35),
    roughness: 0.84,
    metalness: 0.04,
  });
  const canyonMat = new THREE.MeshStandardMaterial({
    name: 'canyon-asphalt',
    map: textures.canyonRoad,
    normalMap: textures.asphaltNormal,
    normalScale: new THREE.Vector2(0.4, 0.4),
    roughness: 0.88,
    metalness: 0.03,
  });

  const plazaTex = textures.plazaAsphalt;
  plazaTex.repeat.set(14, 14);
  const plazaMat = new THREE.MeshStandardMaterial({
    name: 'plaza-asphalt',
    map: plazaTex,
    normalMap: textures.asphaltNormal,
    normalScale: new THREE.Vector2(0.28, 0.28),
    roughness: 0.82,
    metalness: 0.04,
  });

  const apronTex = textures.provingApron;
  apronTex.repeat.set(22, 26);
  const apronMat = new THREE.MeshStandardMaterial({
    name: 'proving-apron',
    map: apronTex,
    normalMap: textures.asphaltNormal,
    normalScale: new THREE.Vector2(0.25, 0.25),
    roughness: 0.85,
    metalness: 0.03,
  });

  const paintYellowMat = new THREE.MeshStandardMaterial({
    name: 'road-paint-yellow',
    color: 0xf2b824,
    roughness: 0.65,
    metalness: 0.02,
    polygonOffset: true,
    polygonOffsetFactor: -2,
    polygonOffsetUnits: -2,
  });
  const paintWhiteMat = new THREE.MeshStandardMaterial({
    name: 'road-paint-white',
    color: 0xe9edf2,
    roughness: 0.65,
    metalness: 0.02,
    polygonOffset: true,
    polygonOffsetFactor: -2,
    polygonOffsetUnits: -2,
  });
  const paintRedMat = new THREE.MeshStandardMaterial({
    name: 'road-paint-red',
    color: 0xd94336,
    roughness: 0.65,
    metalness: 0.02,
    polygonOffset: true,
    polygonOffsetFactor: -2,
    polygonOffsetUnits: -2,
  });

  materials.push(highwayMat, canyonMat, plazaMat, apronMat, paintYellowMat, paintWhiteMat, paintRedMat);

  // Build road ribbons. Connectors sit 1.2cm lower at junctions so main highway markings stay clean on top.
  for (const road of network.roads) {
    const isHighway = road.kind === 'highway';
    const yOff = isHighway ? 0.015 : road.kind === 'connector' ? 0.004 : 0.01;
    const tileLen = isHighway ? 24 : 18;
    const geo = buildRoadRibbonGeometry(road, tileLen, yOff);
    geometries.push(geo);

    const mesh = new THREE.Mesh(geo, isHighway ? highwayMat : canyonMat);
    mesh.name = `road:${road.id}`;
    mesh.receiveShadow = true;
    mesh.matrixAutoUpdate = false;
    group.add(mesh);
  }

  // Flat paved pads (Garage Plaza & Proving Grounds).
  for (const pad of FLAT_PADS) {
    const w = pad.maxX - pad.minX;
    const d = pad.maxZ - pad.minZ;
    const cx = (pad.minX + pad.maxX) * 0.5;
    const cz = (pad.minZ + pad.maxZ) * 0.5;
    const geo = new THREE.PlaneGeometry(w, d);
    geo.rotateX(-Math.PI / 2);
    geometries.push(geo);

    const mesh = new THREE.Mesh(geo, pad.id === 'garage-plaza' ? plazaMat : apronMat);
    mesh.name = `pad:${pad.id}`;
    mesh.position.set(cx, pad.y + 0.002, cz);
    mesh.receiveShadow = true;
    mesh.updateMatrix();
    mesh.matrixAutoUpdate = false;
    group.add(mesh);
  }

  // Ground markings in the Garage Plaza & Crash Proving Grounds batched into 3 meshes (yellow/white/red).
  const stripeBatch = new MeshBatcher();
  const addStripe = (mat: THREE.Material, w: number, d: number, x: number, z: number, yaw = 0) => {
    stripeBatch.decal(mat, w, d, x, 0.025, z, yaw);
  };

  // Spawn box outline around (0, 0, 0).
  addStripe(paintYellowMat, 5.2, 0.28, 0, -4.4);
  addStripe(paintYellowMat, 5.2, 0.28, 0, 4.4);
  addStripe(paintYellowMat, 0.28, 9.0, -2.6, 0);
  addStripe(paintYellowMat, 0.28, 9.0, 2.6, 0);

  // Parking bay lines in front of the Blend Garage Exterior bays.
  for (let i = -3; i <= 3; i++) {
    if (i === 0) continue;
    addStripe(paintWhiteMat, 0.22, 7.5, i * 6.5, -16);
  }

  // Impact Wall runway lane lines (Z = +20, X = 90..202) + red/white impact zone stripes.
  addStripe(paintYellowMat, 112, 0.35, 146, 13.5);
  addStripe(paintYellowMat, 112, 0.35, 146, 26.5);
  for (let x = 110; x <= 190; x += 20) {
    addStripe(paintWhiteMat, 1.4, 12.2, x, 20);
  }
  addStripe(paintRedMat, 8.0, 12.8, 200, 20);

  // Stunt Ramp approach lane (Z = -24, X = 84..195).
  addStripe(paintWhiteMat, 110, 0.3, 139, -30.5);
  addStripe(paintWhiteMat, 110, 0.3, 139, -17.5);

  // Slalom course lane boundaries (Z = +88, X = 88..224).
  addStripe(paintYellowMat, 136, 0.3, 156, 76);
  addStripe(paintYellowMat, 136, 0.3, 156, 100);

  // Suspension rumble strip lane (Z = -56, X = 90..205).
  addStripe(paintWhiteMat, 115, 0.28, 147.5, -62);
  addStripe(paintWhiteMat, 115, 0.28, 147.5, -50);

  const stripesGroup = stripeBatch.build('road-stripes', { castShadow: false, receiveShadow: true });
  stripesGroup.traverse((obj) => {
    if (obj instanceof THREE.Mesh) geometries.push(obj.geometry);
  });
  group.add(stripesGroup);

  return { group, geometries, materials };
}

/**
 * Computes exact road/pad blend factor & target elevation for terrain sculpting.
 */
export function computeRoadBlend(network: RoadNetwork, x: number, z: number): {
  flattenWeight: number;
  depressWeight: number;
  targetY: number;
} {
  const q = network.query(x, z);
  const padMargin = q.sample ? 18 : 22;
  // Keep exact road elevation out to 4m past the asphalt edge so heightfield interpolation stays smooth on hills.
  const flattenWeight = 1 - smoothstep(4.0, padMargin, q.distance);
  // Depress visual terrain slightly under actual paved surfaces so zero Z-fighting ever occurs.
  const depressWeight = q.onRoad ? 1 : 1 - smoothstep(0, 1.0, q.distance);
  return { flattenWeight, depressWeight, targetY: q.roadY };
}
