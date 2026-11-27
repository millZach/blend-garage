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
  // 5. Winding Hillside / Canyon Pass — sweeping S-curves climbing up to +15m elevation and joining the Highway Loop.
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
      [-290, 14.8, -78],
      [-235, 14.0, -145],
      [-255, 7.2, -196],
      [-259, 5.22, -226],
      [-260, 5.2, -246],
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
    if (spec.kind === 'canyon' && i > 1 && i < n - 2) {
      const a = rawPoints[i - 1];
      const b = rawPoints[i + 1];
      const v1x = curr.x - a.x;
      const v1z = curr.z - a.z;
      const v2x = b.x - curr.x;
      const v2z = b.z - curr.z;
      const cross = v1x * v2z - v1z * v2x;
      const denom = (Math.hypot(v1x, v1z) * Math.hypot(v2x, v2z) + 1e-4) * spec.spacing;
      bankRad = clamp((cross / denom) * 0.45, -0.055, 0.055);
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
    let bestCenterDist = Infinity;
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
 * Builds a 6-vertex cross-section road ribbon with asphalt crown, weathered gravel shoulder,
 * and a softly graded earth verge dipping cleanly into the terrain so roads never look pasted on.
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
  const asphaltEdgeU = isHighway ? 0.115 : 0.13;

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
    const shW = hw + (isHighway ? 1.35 : 1.15);
    const vergeW = shW + (isHighway ? 2.6 : 2.8);
    const y = s.y + yOffset;
    const vCoord = distAccum / tileMeters;

    const ringOffsets: readonly [number, number, number][] = [
      [vergeW, y - 0.75, 0.0],
      [shW, y - 0.06, asphaltEdgeU * 0.45],
      [hw, y, asphaltEdgeU],
      [-hw, y, 1 - asphaltEdgeU],
      [-shW, y - 0.06, 1 - asphaltEdgeU * 0.45],
      [-vergeW, y - 0.75, 1.0],
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

  // Two-step chamfered curb profile (wide gutter base + tapered concrete cap).
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
 * Builds all road ribbons, plaza tarmac, proving grounds concrete apron, chamfered concrete curbs,
 * weathered painted lane markings, and stenciled crash-test runway distance markers.
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
    plazaMat,
    apronMat,
    curbMat,
    paintYellowMat,
    paintWhiteMat,
    paintRedMat,
  );

  // Build road ribbons. Connectors sit 1cm lower at junctions so main highway markings stay clean on top.
  for (const road of network.roads) {
    const isHighway = road.kind === 'highway';
    const yOff = isHighway ? 0.02 : road.kind === 'connector' ? 0.006 : 0.025;
    const tileLen = isHighway ? 24 : 18;
    const geo = buildRoadRibbonGeometry(road, tileLen, yOff);
    geometries.push(geo);

    const mesh = new THREE.Mesh(geo, isHighway ? highwayMat : canyonMat);
    mesh.name = `road:${road.id}`;
    mesh.receiveShadow = true;
    mesh.matrixAutoUpdate = false;
    group.add(mesh);
  }

  // Flat paved pads (Garage Plaza & Proving Grounds) with world-scaled UVs so shared textures stay 1:1.
  for (const pad of FLAT_PADS) {
    const w = pad.maxX - pad.minX;
    const d = pad.maxZ - pad.minZ;
    const cx = (pad.minX + pad.maxX) * 0.5;
    const cz = (pad.minZ + pad.maxZ) * 0.5;
    const geo = new THREE.PlaneGeometry(w, d);
    geo.rotateX(-Math.PI / 2);
    const tileMeters = pad.id === 'garage-plaza' ? 10 : 12;
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

  // Chamfered weathered concrete curbs framing the Garage Plaza, Highway Approach, and Proving Grounds.
  const curbBatch = new MeshBatcher();
  curbBatch.useWorldUv(curbMat, 4);

  // Garage Plaza south curb (leaving open 18m gateway for Highway Connector at X = -9..+9).
  addCurbRun(curbBatch, curbMat, -53.8, 53.8, -9.2, 53.8);
  addCurbRun(curbBatch, curbMat, 9.2, 53.8, 53.8, 53.8);
  // Garage Plaza east curb (leaving open 20m gateway for Proving Grounds at Z = 10..30).
  addCurbRun(curbBatch, curbMat, 53.8, -51.8, 53.8, 10.0);
  addCurbRun(curbBatch, curbMat, 53.8, 30.0, 53.8, 53.8);
  // Garage Plaza west curb (leaving open 16m gateway for Canyon Pass at Z = 0..16).
  addCurbRun(curbBatch, curbMat, -53.8, -51.8, -53.8, 0.0);
  addCurbRun(curbBatch, curbMat, -53.8, 16.0, -53.8, 53.8);
  // Garage Plaza north curb behind HQ.
  addCurbRun(curbBatch, curbMat, -53.8, -51.8, 53.8, -51.8);

  // Plaza-to-Highway Connector boulevard curbs (X = ±7.8, Z = 54..248).
  addCurbRun(curbBatch, curbMat, -7.8, 54.0, -7.8, 248.0);
  addCurbRun(curbBatch, curbMat, 7.8, 54.0, 7.8, 248.0);

  // Proving Grounds outer concrete curbs (open at West entry Z=10..30 and South exit X=150..170).
  addCurbRun(curbBatch, curbMat, 74.2, -77.8, 74.2, 10.0);
  addCurbRun(curbBatch, curbMat, 74.2, 30.0, 74.2, 123.8);
  addCurbRun(curbBatch, curbMat, 74.2, 123.8, 151.0, 123.8);
  addCurbRun(curbBatch, curbMat, 169.0, 123.8, 241.8, 123.8);

  const curbGroup = curbBatch.build('road-curbs', { castShadow: false, receiveShadow: true });
  curbGroup.traverse((obj) => {
    if (obj instanceof THREE.Mesh) geometries.push(obj.geometry);
  });
  group.add(curbGroup);

  // Ground markings in the Garage Plaza & Crash Proving Grounds batched into 3 meshes (yellow/white/red).
  const stripeBatch = new MeshBatcher();
  const addStripe = (mat: THREE.Material, w: number, d: number, x: number, z: number, yaw = 0) => {
    stripeBatch.decal(mat, w, d, x, 0.024, z, yaw);
  };

  // Spawn staging box outline around (0, 0, 0) + subtle corner brackets.
  addStripe(paintYellowMat, 5.4, 0.24, 0, -4.5);
  addStripe(paintYellowMat, 5.4, 0.24, 0, 4.5);
  addStripe(paintYellowMat, 0.24, 9.2, -2.7, 0);
  addStripe(paintYellowMat, 0.24, 9.2, 2.7, 0);

  // Parking bay lines in front of the Blend Garage HQ bays.
  for (let i = -3; i <= 3; i++) {
    if (i === 0) continue;
    addStripe(paintWhiteMat, 0.2, 7.8, i * 6.5, -16);
  }
  // Yellow safety crosswalk strip across garage apron.
  for (let x = -20; x <= 20; x += 2.6) {
    addStripe(paintYellowMat, 1.3, 1.1, x, -9.2);
  }

  // Impact Wall runway lane lines (Z = +20, X = 90..202) + distance ticks + red impact zone.
  addStripe(paintYellowMat, 114, 0.34, 147, 13.5);
  addStripe(paintYellowMat, 114, 0.34, 147, 26.5);
  // Subtle center guide dashes down the crash test lane.
  for (let x = 94; x <= 192; x += 8) {
    addStripe(paintWhiteMat, 3.6, 0.18, x, 20);
  }
  // Transverse distance bars at 100m (X=106), 75m (X=131), 50m (X=156), 25m (X=181).
  for (const x of [106, 131, 156, 181]) {
    addStripe(paintWhiteMat, 0.9, 12.6, x, 20);
  }
  addStripe(paintRedMat, 7.2, 12.8, 200.5, 20);

  // Stunt Ramp approach lane (Z = -24, X = 84..195).
  addStripe(paintWhiteMat, 110, 0.28, 139, -30.5);
  addStripe(paintWhiteMat, 110, 0.28, 139, -17.5);
  for (let x = 86; x <= 102; x += 5.5) {
    addStripe(paintYellowMat, 1.4, 8.6, x, -24);
  }

  // Slalom course lane boundaries (Z = +88, X = 88..224).
  addStripe(paintYellowMat, 136, 0.28, 156, 76);
  addStripe(paintYellowMat, 136, 0.28, 156, 100);

  // Suspension rumble strip lane (Z = -56, X = 90..205).
  addStripe(paintWhiteMat, 115, 0.26, 147.5, -62);
  addStripe(paintWhiteMat, 115, 0.26, 147.5, -50);

  const stripesGroup = stripeBatch.build('road-stripes', { castShadow: false, receiveShadow: true });
  stripesGroup.traverse((obj) => {
    if (obj instanceof THREE.Mesh) geometries.push(obj.geometry);
  });
  group.add(stripesGroup);

  // Stenciled weathered runway distance markers ("100M", "50M", "25M", "IMPACT") on the Crash Wall lane.
  const runwaySpecs: readonly { tex: THREE.Texture; x: number; z: number; w: number; d: number }[] = [
    { tex: textures.runwayDecals.mark100m, x: 111.5, z: 20, w: 6.4, d: 3.2 },
    { tex: textures.runwayDecals.mark50m, x: 161.5, z: 20, w: 6.4, d: 3.2 },
    { tex: textures.runwayDecals.mark25m, x: 186.5, z: 20, w: 6.4, d: 3.2 },
    { tex: textures.runwayDecals.markImpact, x: 200.5, z: 20, w: 6.8, d: 3.4 },
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
    // Rotate so text reads upright for a car driving eastbound (+X) toward the crash wall.
    decalGeo.rotateY(-Math.PI / 2);
    geometries.push(decalGeo);
    const mesh = new THREE.Mesh(decalGeo, decalMat);
    mesh.position.set(r.x, 0.032, r.z);
    mesh.receiveShadow = true;
    mesh.updateMatrix();
    mesh.matrixAutoUpdate = false;
    group.add(mesh);
  }

  return { group, geometries, materials };
}

/**
 * Computes exact road/pad blend factor & target elevation for terrain sculpting.
 */
export function computeRoadBlend(network: RoadNetwork, x: number, z: number): {
  flattenWeight: number;
  depressWeight: number;
  depressDepth: number;
  targetY: number;
} {
  const q = network.query(x, z);
  const isSplineRoad = q.sample !== null;
  const padMargin = isSplineRoad ? 22 : 22;
  // Keep exact road elevation well past the asphalt edge so heightfield triangles stay smooth on curved hills.
  const flattenWeight = 1 - smoothstep(isSplineRoad ? 5.5 : 4.0, padMargin, q.distance);

  // Depress visual terrain across the full road + shoulder corridor so coarse 7.5m terrain triangles
  // bridging curved hillside bends (e.g. Canyon Pass) can never poke through the asphalt ribbon.
  const depressWeight = isSplineRoad
    ? 1 - smoothstep(3.2, 9.2, q.distance)
    : q.onRoad
      ? 1
      : 1 - smoothstep(0, 1.5, q.distance);

  // Deeper visual cut under elevated/sloped spline roads (tucked seamlessly under the -0.75m road earth verge).
  const depressDepth = isSplineRoad && q.roadY > 0.2 ? 0.64 : 0.2;

  return { flattenWeight, depressWeight, depressDepth, targetY: q.roadY };
}
