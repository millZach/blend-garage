import * as THREE from 'three';
import type { Vec3 } from '@blend-garage/vehicle-core';
import { clamp, smoothstep } from '../math';
import { MeshBatcher } from '../MeshBatcher';
import type { WorldTextures } from './textures';
import { shorelineXAtZ } from './water';

export type SpawnName = 'start' | 'coast' | 'highway' | 'canyon' | 'desert' | 'proving-grounds';

export type WorldSurfaceKind = 'asphalt' | 'concrete' | 'gravel' | 'dirt' | 'grass';

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
  roadKind: RoadKind;
}

export interface FlatPad {
  id: string;
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
  y: number;
  blendMargin: number;
  surface: WorldSurfaceKind;
}

export type RoadKind = 'highway' | 'canyon' | 'coast' | 'dirt' | 'connector';

export interface RoadDefinition {
  id: string;
  kind: RoadKind;
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
  pad: FlatPad | null;
}

/** Exact drivable bounds of the 280m illuminated Concrete Mountain Tunnel on North Valley Expressway. */
export const TUNNEL_BOUNDS = {
  minX: -160,
  maxX: 120,
  centerZ: -620,
  halfWidth: 10.5,
  floorY: 12.0,
  ceilingY: 20.4,
} as const;

/** Exact span of the Steel-Arch Pacific Coast Bridge over the ocean bay inlet. */
export const COAST_BRIDGE_BOUNDS = {
  centerX: -720,
  minZ: -128,
  maxZ: 128,
  halfWidth: 7.4,
  deckY: 14.5,
} as const;

/** Returns true if world position (x, y, z) is inside the Mountain Tunnel (drives audio reverb). */
export function isInsideTunnelCoords(x: number, y: number, z: number): boolean {
  return (
    x >= TUNNEL_BOUNDS.minX &&
    x <= TUNNEL_BOUNDS.maxX &&
    Math.abs(z - TUNNEL_BOUNDS.centerZ) <= TUNNEL_BOUNDS.halfWidth &&
    y >= TUNNEL_BOUNDS.floorY - 1.5 &&
    y <= TUNNEL_BOUNDS.ceilingY + 1.0
  );
}

/** Returns true if (x, z) lies over the open-water coastal bay spanned by the Steel-Arch Bridge. */
export function isOnCoastBridgeSpan(x: number, z: number): boolean {
  return (
    Math.abs(x - COAST_BRIDGE_BOUNDS.centerX) <= COAST_BRIDGE_BOUNDS.halfWidth + 24 &&
    z >= COAST_BRIDGE_BOUNDS.minZ + 6 &&
    z <= COAST_BRIDGE_BOUNDS.maxZ - 6
  );
}

/** Flat paved zones: Central Blend Garage HQ Plaza & South-West Expanded Crash Arena / Airfield Stunt Park. */
export const FLAT_PADS: readonly FlatPad[] = [
  {
    id: 'garage-plaza',
    minX: -64,
    maxX: 64,
    minZ: -60,
    maxZ: 64,
    y: 0,
    blendMargin: 22,
    surface: 'asphalt',
  },
  {
    id: 'proving-grounds',
    minX: -540,
    maxX: -140,
    minZ: 440,
    maxZ: 940,
    y: 0,
    blendMargin: 28,
    surface: 'concrete',
  },
];

interface RoadControlSpec {
  id: string;
  kind: RoadKind;
  closed: boolean;
  halfWidth: number;
  spacing: number;
  points: readonly [number, number, number][];
}

const ROAD_SPECS: readonly RoadControlSpec[] = [
  // 1. Valley Expressway Loop (~5.2 km 4-lane circuit):
  //    - 1.36 km dead-flat South High-Speed Straightaway along Z = +340 (X = -680 -> +680)
  //    - Sweeping East/North curves through the 280m Illuminated Concrete Mountain Tunnel (Z = -620, X = +120 -> -160)
  {
    id: 'highway-loop',
    kind: 'highway',
    closed: true,
    halfWidth: 9.0,
    spacing: 4.5,
    points: [
      [-680, 0, 340],
      [-340, 0, 340],
      [0, 0, 340],
      [340, 0, 340],
      [680, 0, 340],
      [855, 2.0, 225],
      [910, 6.0, 10],
      [865, 10.5, -245],
      [710, 12.0, -510],
      [440, 12.0, -610],
      [180, 12.0, -620],
      [120, 12.0, -620],
      [-20, 12.0, -620],
      [-160, 12.0, -620],
      [-260, 12.0, -620],
      [-520, 12.0, -565],
      [-585, 9.5, -330],
      [-525, 5.5, -60],
      [-575, 2.5, 175],
    ],
  },

  // 2. Pacific Coast Highway (West oceanfront scenic drive + Steel-Arch Coastal Bridge at X = -720, Z = +128 -> -128):
  {
    id: 'pacific-coast-hwy',
    kind: 'coast',
    closed: false,
    halfWidth: 6.6,
    spacing: 4.0,
    points: [
      [-680, 0, 340],
      [-748, 4.5, 292],
      [-734, 12.2, 212],
      [-720, 14.5, 152],
      [-720, 14.5, 128],
      [-720, 14.5, 0],
      [-720, 14.5, -128],
      [-720, 14.5, -162],
      [-756, 13.6, -285],
      [-744, 12.6, -435],
      [-665, 12.1, -535],
      [-520, 12.0, -565],
    ],
  },

  // 3. Plaza South Boulevard: straight from Blend Garage HQ Plaza to Valley Expressway.
  {
    id: 'plaza-highway-connector',
    kind: 'connector',
    closed: false,
    halfWidth: 7.5,
    spacing: 4.0,
    points: [
      [0, 0, 56],
      [0, 0, 150],
      [0, 0, 245],
      [0, 0, 344],
    ],
  },

  // 4. Expressway-to-Airfield Crash Arena Boulevard (wide 18m entry into Proving Grounds).
  {
    id: 'expressway-proving-connector',
    kind: 'connector',
    closed: false,
    halfWidth: 8.5,
    spacing: 3.5,
    points: [
      [-340, 0, 336],
      [-340, 0, 390],
      [-340, 0, 448],
    ],
  },

  // 5. Plaza West Connector linking Blend Garage Plaza toward West Expressway & Pacific Coast.
  {
    id: 'plaza-coast-connector',
    kind: 'connector',
    closed: false,
    halfWidth: 6.4,
    spacing: 4.0,
    points: [
      [-56, 0, 12],
      [-215, 1.0, 55],
      [-405, 2.2, 130],
      [-575, 2.5, 175],
    ],
  },

  // 6. Plaza East Connector linking Blend Garage Plaza directly to East Expressway & Desert Rally entry.
  {
    id: 'plaza-desert-connector',
    kind: 'connector',
    closed: false,
    halfWidth: 6.5,
    spacing: 4.0,
    points: [
      [56, 0, 18],
      [215, 0, 88],
      [365, 0, 215],
      [440, 0, 344],
    ],
  },

  // 7. Redwood & Alpine Switchbacks (North-East Highlands: dramatic climb to +64m summit & descent to Mountain Tunnel):
  {
    id: 'alpine-canyon-pass',
    kind: 'canyon',
    closed: false,
    halfWidth: 6.0,
    spacing: 3.8,
    points: [
      [56, 0, -24],
      [185, 5.5, -88],
      [335, 16.5, -162],
      [505, 29.0, -142],
      [555, 37.5, -225],
      [415, 47.0, -295],
      [585, 57.5, -365],
      [625, 62.5, -445],
      [495, 64.0, -490],
      [345, 43.0, -525],
      [255, 20.5, -562],
      [212, 12.2, -595],
      [182, 12.0, -616],
      [165, 12.0, -620],
    ],
  },

  // 8. Red-Rock Desert Rally Entry Spur (from Expressway Z=+340 south into the packed-dirt rally loop):
  {
    id: 'desert-rally-entry',
    kind: 'dirt',
    closed: false,
    halfWidth: 6.8,
    spacing: 4.0,
    points: [
      [440, 0, 344],
      [445, 0.4, 405],
      [460, 0.8, 468],
    ],
  },

  // 9. Red-Rock Mesa & Dirt Rally Loop (~2.0 km packed terracotta dirt & gravel circuit with undulating crests!):
  {
    id: 'desert-rally-loop',
    kind: 'dirt',
    closed: true,
    halfWidth: 7.2,
    spacing: 4.5,
    points: [
      [460, 0.8, 468],
      [645, 5.2, 470],
      [845, 9.8, 545],
      [935, 6.2, 705],
      [855, 11.8, 885],
      [645, 5.5, 955],
      [425, 8.6, 895],
      [315, 3.8, 730],
      [345, 1.5, 550],
    ],
  },
];

function sampleRoadSpline(spec: RoadControlSpec): RoadDefinition {
  const vectors = spec.points.map(([x, y, z]) => new THREE.Vector3(x, y, z));
  const curve = new THREE.CatmullRomCurve3(vectors, spec.closed, 'centripetal', 0.5);
  const length = curve.getLength();
  const count = Math.max(14, Math.round(length / spec.spacing));

  const rawPoints: THREE.Vector3[] = [];
  for (let i = 0; i < (spec.closed ? count : count + 1); i++) {
    const u = i / count;
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

    let bankRad = 0;
    if ((spec.kind === 'canyon' || spec.kind === 'dirt') && i > 1 && i < n - 2) {
      const a = rawPoints[i - 1];
      const b = rawPoints[i + 1];
      const v1x = curr.x - a.x;
      const v1z = curr.z - a.z;
      const v2x = b.x - curr.x;
      const v2z = b.z - curr.z;
      const cross = v1x * v2z - v1z * v2x;
      const denom = (Math.hypot(v1x, v1z) * Math.hypot(v2x, v2z) + 1e-4) * spec.spacing;
      bankRad = clamp((cross / denom) * 0.4, -0.05, 0.05);
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
      roadKind: spec.kind,
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
 * Spatial grid accelerating road distance, surface, and elevation queries across the 2400x2400m world.
 */
export class RoadNetwork {
  readonly roads: readonly RoadDefinition[];
  readonly allSamples: readonly RoadSample[];
  readonly spawnPoints: Record<SpawnName, WorldSpawnPose>;

  private readonly cellSize = 32;
  private readonly gridOrigin = -1280;
  private readonly gridDim = 80;
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

    const canyonRoad = this.roads.find((r) => r.id === 'alpine-canyon-pass')!;
    const canyonSample = canyonRoad.samples[Math.floor(canyonRoad.samples.length * 0.24)];

    const desertRoad = this.roads.find((r) => r.id === 'desert-rally-loop')!;
    const desertSample = desertRoad.samples[Math.floor(desertRoad.samples.length * 0.03)];

    this.spawnPoints = {
      start: {
        name: 'start',
        label: 'Garage HQ Plaza',
        position: [0, 0.05, 0],
        headingRad: 0,
      },
      coast: {
        name: 'coast',
        label: 'Pacific Coast Hwy',
        position: [-720, COAST_BRIDGE_BOUNDS.deckY + 0.06, 158],
        headingRad: Math.PI,
      },
      highway: {
        name: 'highway',
        label: 'Valley Expressway',
        position: [-460, 0.05, 340],
        headingRad: Math.PI / 2,
      },
      canyon: {
        name: 'canyon',
        label: 'Alpine Switchbacks',
        position: [canyonSample.x, canyonSample.y + 0.06, canyonSample.z],
        headingRad: canyonSample.heading,
      },
      desert: {
        name: 'desert',
        label: 'Red-Rock Rally',
        position: [desertSample.x, desertSample.y + 0.06, desertSample.z],
        headingRad: desertSample.heading,
      },
      'proving-grounds': {
        name: 'proving-grounds',
        label: 'Crash & Stunt Park',
        position: [-468, 0.05, 620],
        headingRad: Math.PI / 2,
      },
    };
  }

  /** Queries distance to the nearest road or paved pad, plus the exact road surface elevation. */
  query(x: number, z: number): RoadQueryResult {
    let bestDist = Infinity;
    let bestCenterDist = Infinity;
    let bestY = 0;
    let bestHalfWidth = 0;
    let bestSample: RoadSample | null = null;
    let bestPad: FlatPad | null = null;
    let onRoad = false;

    for (const pad of FLAT_PADS) {
      const d = padDistance(pad, x, z);
      if (d <= 0) {
        return { distance: 0, roadY: pad.y, halfWidth: 0, onRoad: true, sample: null, pad };
      }
      if (d < bestDist) {
        bestDist = d;
        bestY = pad.y;
        bestHalfWidth = 0;
        bestPad = pad;
      }
    }

    const gx = clamp(Math.floor((x - this.gridOrigin) / this.cellSize), 0, this.gridDim - 1);
    const gz = clamp(Math.floor((z - this.gridOrigin) / this.cellSize), 0, this.gridDim - 1);

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
          // Break edgeDist ties (especially edgeDist === 0 inside the road!) by true closest centerline sample.
          if (
            edgeDist < bestDist - 1e-6 ||
            (Math.abs(edgeDist - bestDist) <= 1e-6 && centerDist < bestCenterDist)
          ) {
            bestDist = edgeDist;
            bestCenterDist = centerDist;
            bestY = s.y;
            bestHalfWidth = s.halfWidth;
            bestSample = s;
            bestPad = null;
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
      pad: bestPad,
    };
  }

  /** Classifies the driving surface at world (x, z) for dust FX & audio tire/gravel crunch. */
  getSurfaceAt(x: number, z: number): WorldSurfaceKind {
    if (isInsideTunnelCoords(x, TUNNEL_BOUNDS.floorY + 1, z)) return 'concrete';
    if (
      Math.abs(x - COAST_BRIDGE_BOUNDS.centerX) <= COAST_BRIDGE_BOUNDS.halfWidth &&
      z >= COAST_BRIDGE_BOUNDS.minZ &&
      z <= COAST_BRIDGE_BOUNDS.maxZ
    ) {
      return 'concrete';
    }

    const q = this.query(x, z);
    if (q.onRoad) {
      if (q.pad) return q.pad.surface;
      if (q.sample?.roadKind === 'dirt') return 'gravel';
      return 'asphalt';
    }

    // Off-road surface by biome.
    if (x < shorelineXAtZ(z) + 42) return 'dirt';
    if (x > 210 && z > 360) return 'gravel';
    return 'grass';
  }

  /** Returns the nearest clean drivable road/pad pose aligned with the road tangent (for Reset-to-Road). */
  nearestRoadPose(x: number, z: number): WorldSpawnPose {
    for (const pad of FLAT_PADS) {
      if (x >= pad.minX + 6 && x <= pad.maxX - 6 && z >= pad.minZ + 6 && z <= pad.maxZ - 6) {
        if (pad.id === 'garage-plaza') {
          return {
            name: 'start',
            label: 'Garage HQ Plaza',
            position: [clamp(x, -42, 42), pad.y + 0.05, clamp(z, -14, 48)],
            headingRad: 0,
          };
        }
        return {
          name: 'proving-grounds',
          label: 'Crash & Stunt Park',
          position: [clamp(x, -510, -210), pad.y + 0.05, clamp(z, 470, 900)],
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
      position: [best.x, best.y + 0.06, best.z],
      headingRad: best.heading,
    };
  }
}

/**
 * Builds a 6-vertex cross-section road ribbon with road crown, weathered shoulder,
 * and a softly graded earth verge dipping cleanly into the terrain so roads never look pasted on.
 * On the Steel-Arch Coastal Bridge span, outer skirts flatten into tight bridge deck curbs.
 */
function buildRoadRibbonGeometry(road: RoadDefinition, tileMeters: number, yOffset: number): THREE.BufferGeometry {
  const samples = road.samples;
  const n = samples.length;
  const ringCount = road.closed ? n + 1 : n;
  const vertsPerRing = 6; // vergeL, shoulderL, edgeL, edgeR, shoulderR, vergeR

  const positions = new Float32Array(ringCount * vertsPerRing * 3);
  const normals = new Float32Array(ringCount * vertsPerRing * 3);
  const uvs = new Float32Array(ringCount * vertsPerRing * 2);

  let distAccum = 0;
  const isHighway = road.kind === 'highway';
  const isDirt = road.kind === 'dirt';
  const asphaltEdgeU = isHighway ? 0.115 : isDirt ? 0.14 : 0.13;

  for (let i = 0; i < ringCount; i++) {
    const s = samples[i % n];
    if (i > 0) {
      const prev = samples[(i - 1) % n];
      distAccum += Math.hypot(s.x - prev.x, s.y - prev.y, s.z - prev.z);
    }

    const lx = s.tz;
    const lz = -s.tx;
    const hw = s.halfWidth;
    const onBridge =
      road.kind === 'coast' &&
      Math.abs(s.x - COAST_BRIDGE_BOUNDS.centerX) < 12 &&
      s.z >= COAST_BRIDGE_BOUNDS.minZ - 2 &&
      s.z <= COAST_BRIDGE_BOUNDS.maxZ + 2;

    const shW = onBridge ? hw + 0.55 : hw + (isHighway ? 1.4 : 1.15);
    const vergeW = onBridge ? hw + 0.72 : shW + (isHighway ? 2.8 : 3.2);
    const skirtDrop = onBridge ? 0.16 : 0.95;
    const y = s.y + yOffset;
    const vCoord = distAccum / tileMeters;

    const ringOffsets: readonly [number, number, number][] = [
      [vergeW, y - skirtDrop, 0.0],
      [shW, y - 0.06, asphaltEdgeU * 0.45],
      [hw, y, asphaltEdgeU],
      [-hw, y, 1 - asphaltEdgeU],
      [-shW, y - 0.06, 1 - asphaltEdgeU * 0.45],
      [-vergeW, y - skirtDrop, 1.0],
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

/** Adds a weathered chamfered concrete curb run along X or Z into the MeshBatcher. */
function addCurbRun(
  batcher: MeshBatcher,
  material: THREE.Material,
  x0: number,
  z0: number,
  x1: number,
  z1: number,
): void {
  const len = Math.hypot(x1 - x0, z1 - z0);
  if (len < 0.5) return;
  const cx = (x0 + x1) * 0.5;
  const cz = (z0 + z1) * 0.5;
  const yaw = Math.atan2(x1 - x0, z1 - z0);

  batcher.at(cx, 0, cz, yaw, () => {
    batcher.slab(material, 0.52, 0.08, len, 0, -0.02, 0);
    batcher.slab(material, 0.34, 0.14, len, 0, 0.06, 0);
  });
}

export interface RoadVisuals {
  group: THREE.Group;
  geometries: THREE.BufferGeometry[];
  materials: THREE.Material[];
}

/**
 * Builds all 6-biome road ribbons (expressway, Pacific Coast, Alpine switchbacks, Red-Rock dirt rally),
 * Blend Garage HQ plaza, Crash Arena & Airfield Stunt Park concrete apron, curbs, figure-8 drift pad
 * rings, and stenciled crash-test runway distance markers.
 */
export function buildRoadVisuals(network: RoadNetwork, textures: WorldTextures): RoadVisuals {
  const group = new THREE.Group();
  group.name = 'world-roads';
  const geometries: THREE.BufferGeometry[] = [];
  const materials: THREE.Material[] = [];

  const highwayMat = new THREE.MeshStandardMaterial({
    name: 'highway-asphalt',
    map: textures.highwayRoad,
    roughnessMap: textures.highwayRough,
    normalMap: textures.asphaltNormal,
    normalScale: new THREE.Vector2(0.55, 0.55),
    roughness: 1.0,
    metalness: 0.03,
    polygonOffset: true,
    polygonOffsetFactor: -1,
    polygonOffsetUnits: -1,
  });

  const canyonMat = new THREE.MeshStandardMaterial({
    name: 'canyon-asphalt',
    map: textures.canyonRoad,
    roughnessMap: textures.canyonRough,
    normalMap: textures.asphaltNormal,
    normalScale: new THREE.Vector2(0.62, 0.62),
    roughness: 1.0,
    metalness: 0.02,
    polygonOffset: true,
    polygonOffsetFactor: -1,
    polygonOffsetUnits: -1,
  });

  const dirtMat = new THREE.MeshStandardMaterial({
    name: 'desert-dirt-rally',
    map: textures.dirtRoad,
    roughnessMap: textures.dirtRough,
    normalMap: textures.terrainNormal,
    normalScale: new THREE.Vector2(0.75, 0.75),
    roughness: 1.0,
    metalness: 0.0,
    polygonOffset: true,
    polygonOffsetFactor: -1,
    polygonOffsetUnits: -1,
  });

  const plazaMat = new THREE.MeshStandardMaterial({
    name: 'plaza-asphalt',
    map: textures.plazaAsphalt,
    roughnessMap: textures.plazaRough,
    normalMap: textures.asphaltNormal,
    normalScale: new THREE.Vector2(0.42, 0.42),
    roughness: 1.0,
    metalness: 0.03,
  });

  const apronMat = new THREE.MeshStandardMaterial({
    name: 'proving-apron',
    map: textures.provingApron,
    roughnessMap: textures.concreteRough,
    normalMap: textures.concreteNormal,
    normalScale: new THREE.Vector2(0.4, 0.4),
    roughness: 1.0,
    metalness: 0.02,
  });

  const curbMat = new THREE.MeshStandardMaterial({
    name: 'weathered-curb',
    map: textures.concrete,
    normalMap: textures.concreteNormal,
    normalScale: new THREE.Vector2(0.45, 0.45),
    roughnessMap: textures.concreteRough,
    color: 0xc9c3b8,
    roughness: 1.0,
    metalness: 0.02,
  });

  const paintYellowMat = new THREE.MeshStandardMaterial({
    name: 'road-paint-yellow',
    color: 0xdca72b,
    roughness: 0.72,
    metalness: 0.02,
    polygonOffset: true,
    polygonOffsetFactor: -2,
    polygonOffsetUnits: -2,
  });
  const paintWhiteMat = new THREE.MeshStandardMaterial({
    name: 'road-paint-white',
    color: 0xdfdfd8,
    roughness: 0.74,
    metalness: 0.02,
    polygonOffset: true,
    polygonOffsetFactor: -2,
    polygonOffsetUnits: -2,
  });
  const paintRedMat = new THREE.MeshStandardMaterial({
    name: 'road-paint-red',
    color: 0xc84336,
    roughness: 0.72,
    metalness: 0.02,
    polygonOffset: true,
    polygonOffsetFactor: -2,
    polygonOffsetUnits: -2,
  });

  materials.push(
    highwayMat,
    canyonMat,
    dirtMat,
    plazaMat,
    apronMat,
    curbMat,
    paintYellowMat,
    paintWhiteMat,
    paintRedMat,
  );

  for (const road of network.roads) {
    const isHighway = road.kind === 'highway';
    const isDirt = road.kind === 'dirt';
    const yOff = isHighway ? 0.022 : road.kind === 'connector' ? 0.008 : 0.032;
    const tileLen = isHighway ? 24 : isDirt ? 20 : 18;
    const geo = buildRoadRibbonGeometry(road, tileLen, yOff);
    geometries.push(geo);

    const mat = isHighway ? highwayMat : isDirt ? dirtMat : canyonMat;
    const mesh = new THREE.Mesh(geo, mat);
    mesh.name = `road:${road.id}`;
    mesh.receiveShadow = true;
    mesh.matrixAutoUpdate = false;
    group.add(mesh);
  }

  // Flat paved pads (Garage Plaza & Expanded Crash Arena / Airfield Stunt Park).
  for (const pad of FLAT_PADS) {
    const w = pad.maxX - pad.minX;
    const d = pad.maxZ - pad.minZ;
    const cx = (pad.minX + pad.maxX) * 0.5;
    const cz = (pad.minZ + pad.maxZ) * 0.5;
    const geo = new THREE.PlaneGeometry(w, d);
    geo.rotateX(-Math.PI / 2);
    const tileMeters = pad.id === 'garage-plaza' ? 10 : 14;
    const uvAttr = geo.attributes.uv as THREE.BufferAttribute;
    for (let i = 0; i < uvAttr.count; i++) {
      uvAttr.setXY(i, uvAttr.getX(i) * (w / tileMeters), uvAttr.getY(i) * (d / tileMeters));
    }
    geometries.push(geo);

    const mesh = new THREE.Mesh(geo, pad.id === 'garage-plaza' ? plazaMat : apronMat);
    mesh.name = `pad:${pad.id}`;
    mesh.position.set(cx, pad.y + 0.002, cz);
    mesh.receiveShadow = true;
    mesh.updateMatrix();
    mesh.matrixAutoUpdate = false;
    group.add(mesh);
  }

  // Chamfered weathered concrete curbs framing the Garage Plaza, South Approach, and Airfield Stunt Park.
  const curbBatch = new MeshBatcher();
  curbBatch.useWorldUv(curbMat, 4);

  // Garage Plaza perimeter curbs (leaving wide road exits open on all 4 sides).
  addCurbRun(curbBatch, curbMat, -63.8, 63.8, -9.5, 63.8);
  addCurbRun(curbBatch, curbMat, 9.5, 63.8, 63.8, 63.8);
  addCurbRun(curbBatch, curbMat, 63.8, -59.8, 63.8, -34.0);
  addCurbRun(curbBatch, curbMat, 63.8, -12.0, 63.8, 7.0);
  addCurbRun(curbBatch, curbMat, 63.8, 29.0, 63.8, 63.8);
  addCurbRun(curbBatch, curbMat, -63.8, -59.8, -63.8, 1.0);
  addCurbRun(curbBatch, curbMat, -63.8, 23.0, -63.8, 63.8);
  addCurbRun(curbBatch, curbMat, -63.8, -59.8, 63.8, -59.8);

  // South Plaza Boulevard curbs.
  addCurbRun(curbBatch, curbMat, -8.2, 64.0, -8.2, 328.0);
  addCurbRun(curbBatch, curbMat, 8.2, 64.0, 8.2, 328.0);

  // Airfield Crash Arena north entry curbs (leaving wide entry open at X = -352..-328).
  addCurbRun(curbBatch, curbMat, -539.8, 440.2, -352.0, 440.2);
  addCurbRun(curbBatch, curbMat, -328.0, 440.2, -140.2, 440.2);
  addCurbRun(curbBatch, curbMat, -539.8, 440.2, -539.8, 939.8);
  addCurbRun(curbBatch, curbMat, -140.2, 440.2, -140.2, 939.8);
  addCurbRun(curbBatch, curbMat, -539.8, 939.8, -140.2, 939.8);

  const curbGroup = curbBatch.build('road-curbs', { castShadow: false, receiveShadow: true });
  curbGroup.traverse((obj) => {
    if (obj instanceof THREE.Mesh) geometries.push(obj.geometry);
  });
  group.add(curbGroup);

  // Ground markings across Garage Plaza & Expanded Crash Arena / Airfield Stunt Park.
  const stripeBatch = new MeshBatcher();
  const addStripe = (mat: THREE.Material, w: number, d: number, x: number, z: number, yaw = 0) => {
    stripeBatch.decal(mat, w, d, x, 0.025, z, yaw);
  };

  // Spawn staging box outline around (0, 0, 0).
  addStripe(paintYellowMat, 5.4, 0.24, 0, -4.5);
  addStripe(paintYellowMat, 5.4, 0.24, 0, 4.5);
  addStripe(paintYellowMat, 0.24, 9.2, -2.7, 0);
  addStripe(paintYellowMat, 0.24, 9.2, 2.7, 0);

  // Parking bay lines & crosswalk in front of Blend Garage HQ.
  for (let i = -3; i <= 3; i++) {
    if (i === 0) continue;
    addStripe(paintWhiteMat, 0.2, 7.8, i * 6.5, -16);
  }
  for (let x = -20; x <= 20; x += 2.6) {
    addStripe(paintYellowMat, 1.3, 1.1, x, -9.2);
  }

  // --- Expanded Crash Arena & Airfield Stunt Park (X: -540..-140, Z: 440..940) ---
  // (1) High-Speed Target Crash Wall Runway (Z = 620, X = -500..-225, wall at X = -216):
  addStripe(paintYellowMat, 280, 0.38, -360, 610);
  addStripe(paintYellowMat, 280, 0.38, -360, 630);
  for (let x = -492; x <= -234; x += 10) {
    addStripe(paintWhiteMat, 4.5, 0.22, x, 620);
  }
  for (const x of [-318, -293, -268, -243]) {
    addStripe(paintWhiteMat, 1.0, 19.2, x, 620);
  }
  addStripe(paintRedMat, 8.0, 19.6, -224, 620);

  // (2) 3 Progressive Stunt Jump Ramp Lanes (Z = 505 Small, Z = 540 Medium, Z = 576 Mega):
  for (const rz of [505, 540, 576]) {
    addStripe(paintWhiteMat, 260, 0.3, -365, rz - 9.5);
    addStripe(paintWhiteMat, 260, 0.3, -365, rz + 9.5);
  }
  // Launch lead-in chevrons.
  for (let x = -445; x <= -425; x += 6) {
    addStripe(paintYellowMat, 1.5, 11.0, x, 505);
    addStripe(paintYellowMat, 1.5, 12.0, x, 540);
    addStripe(paintRedMat, 1.8, 14.0, x, 576);
  }

  // (3) Figure-8 Drift Skidpad (centered around X = -340, Z = 760, twin circles at X = -402 & X = -278):
  const driftCenters: readonly [number, number][] = [
    [-402, 760],
    [-278, 760],
  ];
  const driftR = 54;
  const ringSteps = 36;
  for (const [dcx, dcz] of driftCenters) {
    for (let i = 0; i < ringSteps; i++) {
      const a0 = (i / ringSteps) * Math.PI * 2;
      const a1 = ((i + 1) / ringSteps) * Math.PI * 2;
      const mx = dcx + Math.cos((a0 + a1) * 0.5) * driftR;
      const mz = dcz + Math.sin((a0 + a1) * 0.5) * driftR;
      const segLen = (2 * Math.PI * driftR) / ringSteps;
      const yaw = Math.atan2(Math.cos(a1) - Math.cos(a0), Math.sin(a1) - Math.sin(a0));
      addStripe(paintWhiteMat, 0.45, segLen * 0.92, mx, mz, yaw);
    }
    // Inner apex circle markings.
    for (let i = 0; i < 16; i++) {
      const a = (i / 16) * Math.PI * 2;
      addStripe(paintYellowMat, 0.35, 4.2, dcx + Math.cos(a) * 18, dcz + Math.sin(a) * 18, a);
    }
  }

  // (4) Suspension Speed-Bump & Articulation Lane (Z = 880, X = -475..-270):
  addStripe(paintWhiteMat, 210, 0.3, -372, 872);
  addStripe(paintWhiteMat, 210, 0.3, -372, 888);

  const stripesGroup = stripeBatch.build('road-stripes', { castShadow: false, receiveShadow: true });
  stripesGroup.traverse((obj) => {
    if (obj instanceof THREE.Mesh) geometries.push(obj.geometry);
  });
  group.add(stripesGroup);

  // Stenciled runway distance markers ("100M", "50M", "25M", "IMPACT") on the Target Wall lane (Z = 620).
  const runwaySpecs: readonly { tex: THREE.Texture; x: number; z: number; w: number; d: number }[] = [
    { tex: textures.runwayDecals.mark100m, x: -312, z: 620, w: 7.4, d: 3.7 },
    { tex: textures.runwayDecals.mark50m, x: -262, z: 620, w: 7.4, d: 3.7 },
    { tex: textures.runwayDecals.mark25m, x: -237, z: 620, w: 7.4, d: 3.7 },
    { tex: textures.runwayDecals.markImpact, x: -224, z: 620, w: 7.8, d: 3.9 },
  ];
  for (let i = 0; i < runwaySpecs.length; i++) {
    const r = runwaySpecs[i];
    const decalMat = new THREE.MeshStandardMaterial({
      name: `runway-decal-${i}`,
      map: r.tex,
      transparent: true,
      roughness: 0.78,
      metalness: 0.02,
      depthWrite: false,
      polygonOffset: true,
      polygonOffsetFactor: -3,
      polygonOffsetUnits: -3,
    });
    materials.push(decalMat);
    const decalGeo = new THREE.PlaneGeometry(r.w, r.d);
    decalGeo.rotateX(-Math.PI / 2);
    decalGeo.rotateY(-Math.PI / 2);
    geometries.push(decalGeo);
    const mesh = new THREE.Mesh(decalGeo, decalMat);
    mesh.position.set(r.x, 0.035, r.z);
    mesh.receiveShadow = true;
    mesh.updateMatrix();
    mesh.matrixAutoUpdate = false;
    group.add(mesh);
  }

  return { group, geometries, materials };
}

/**
 * Computes exact road/pad blend factor & target elevation for 2400x2400m terrain sculpting.
 * Skips terrain flattening across the open-water Steel-Arch Coastal Bridge span so the ocean
 * bay flows naturally beneath the bridge deck.
 */
export function computeRoadBlend(network: RoadNetwork, x: number, z: number): {
  flattenWeight: number;
  depressWeight: number;
  depressDepth: number;
  targetY: number;
} {
  // Keep ocean bay open under the Steel-Arch Coastal Bridge!
  if (isOnCoastBridgeSpan(x, z)) {
    return { flattenWeight: 0, depressWeight: 0, depressDepth: 0, targetY: 0 };
  }

  const q = network.query(x, z);
  const isSplineRoad = q.sample !== null;

  // Ensure smooth transition from terrain onto bridge abutments at Z = ±128.
  if (
    q.sample?.roadId === 'pacific-coast-hwy' &&
    Math.abs(x - COAST_BRIDGE_BOUNDS.centerX) < 28 &&
    Math.abs(z) < 126
  ) {
    return { flattenWeight: 0, depressWeight: 0, depressDepth: 0, targetY: 0 };
  }

  // Ensure EVERY 11.76m terrain grid vertex bordering a road sits at exact road elevation so steep
  // +64m Alpine/Mountain slopes next to curved highways can NEVER bridge above the asphalt!
  const padMargin = isSplineRoad ? 38 : 26;
  const flattenInner = isSplineRoad ? 13.0 : 5.0;
  const flattenWeight = 1 - smoothstep(flattenInner, padMargin, q.distance);

  const depressWeight = isSplineRoad
    ? 1 - smoothstep(6.5, 17.5, q.distance)
    : q.onRoad
      ? 1
      : 1 - smoothstep(0, 2.0, q.distance);

  // Steep alpine/highway cuts stay tucked smoothly beneath the -0.95m road earth verge.
  const depressDepth = isSplineRoad && q.roadY > 0.25 ? 0.84 : 0.24;

  return { flattenWeight, depressWeight, depressDepth, targetY: q.roadY };
}
