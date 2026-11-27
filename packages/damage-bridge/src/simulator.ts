import type { Vec3 } from '@blend-garage/vehicle-core';
import { classifyDamagePart, type PartClassification } from './parts.js';
import { MeshSpatialIndex } from './spatialGrid.js';
import {
  cloneMechanicalHealth,
  createHealthyMechanicalHealth,
  type DamageBounds,
  type DamageInitConfig,
  type DamageSimulator,
  type DamageStepResult,
  type DeformableMeshPayload,
  type DetachedPartImpulse,
  type ImpactEvent,
  type MechanicalHealth,
  type RealDamageSimulatorOptions,
} from './types.js';

interface MeshEntry {
  payload: DeformableMeshPayload;
  classification: PartClassification;
  spatial: MeshSpatialIndex;
  /** Lazily snapshotted original normals when `payload.normals` is first modified. */
  restNormals: Float32Array | null;
  /** Maximum Euclidean displacement currently reached by any vertex in this mesh. */
  maxDisplacement: number;
  /** Whether this mesh's vertex buffer has been mutated since init/reset. */
  dirty: boolean;
}

interface PartGroupState {
  logicalId: string;
  detachable: boolean;
  thresholdJoules: number;
  accumulatedEnergy: number;
  detached: boolean;
  meshes: MeshEntry[];
  center: Vec3;
  bounds: DamageBounds;
}

interface RecentImpact {
  x: number;
  y: number;
  z: number;
  impulse: number;
  time: number;
}

function clamp(value: number, min: number, max: number): number {
  return value < min ? min : value > max ? max : value;
}

const DEFAULT_MIN_IMPULSE = 150;
const DEFAULT_MIN_SPEED = 1.0;
const DEFAULT_COOLDOWN_SECONDS = 0.05;
const DEFAULT_CELL_SIZE = 0.25;
const COOLDOWN_DISTANCE_SQ = 0.35 * 0.35;

/**
 * High-performance 60-fps crash damage & crumple-zone vertex deformation simulator.
 *
 * Designed for high-poly vehicles (250k–10M triangles):
 * - Uses per-mesh O(1) AABB-sphere rejection + flat CSR 3D spatial grids so `applyImpact()`
 *   touches only vertices inside the impact sphere in < 3 ms.
 * - Models BeamNG-style front/rear crumple-zone compliance, smoothstep radial falloff,
 *   deterministic sheet-metal buckling/wrinkling, strain hardening, cumulative displacement caps,
 *   and a rigid cabin safety cell clamp that prevents cabin intrusion and inside-out inversion.
 * - Tracks per-part accumulated crash energy to detach bumpers, spoilers, mirrors, hoods,
 *   fenders, and doors with realistic launch impulses.
 * - Degrades engine, headlights, taillights, per-corner wheel integrity, steering pull,
 *   and overall chassis integrity based on impact zone & energy.
 */
export class RealDamageSimulator implements DamageSimulator {
  readonly name = 'real-crumple-damage';

  private readonly minImpulse: number;
  private readonly minRelativeSpeed: number;
  private readonly cooldownSeconds: number;
  private readonly cellSize: number;
  private readonly maxVertexDisplacementOverride: number | undefined;
  private readonly cabinBoxOverride: DamageBounds | undefined;
  private readonly wheelPositionsOverride: [Vec3, Vec3, Vec3, Vec3] | undefined;
  private readonly thresholdOverrides: Record<string, number> | undefined;
  private readonly updateNormals: boolean;

  private massKg = 1450;
  private meshes: MeshEntry[] = [];
  private partGroups = new Map<string, PartGroupState>();
  private detachedIds = new Set<string>();
  private vehicleBounds: DamageBounds = { min: [-0.95, 0, -2.2], max: [0.95, 1.35, 2.2] };
  private cabinBox: DamageBounds = { min: [-0.57, 0.27, -1.05], max: [0.57, 1.15, 0.88] };
  private wheelPositions: [Vec3, Vec3, Vec3, Vec3] = [
    [0.8, 0.34, 1.32],
    [-0.8, 0.34, 1.32],
    [0.8, 0.34, -1.32],
    [-0.8, 0.34, -1.32],
  ];
  private maxVertexDisplacement = 0.45;

  private health: MechanicalHealth = createHealthyMechanicalHealth();
  private structuralDamage = 0;
  private frontLampDamage = 0;
  private rearLampDamage = 0;
  private steeringBend = 0;

  private simTime = 0;
  private hasStepped = false;
  private recentImpacts: RecentImpact[] = [];

  constructor(options: RealDamageSimulatorOptions = {}) {
    this.minImpulse = options.minImpulse ?? DEFAULT_MIN_IMPULSE;
    this.minRelativeSpeed = options.minRelativeSpeed ?? DEFAULT_MIN_SPEED;
    this.cooldownSeconds = options.cooldownSeconds ?? DEFAULT_COOLDOWN_SECONDS;
    this.cellSize = options.cellSize ?? DEFAULT_CELL_SIZE;
    this.maxVertexDisplacementOverride = options.maxVertexDisplacement;
    this.cabinBoxOverride = options.cabinBox;
    this.wheelPositionsOverride = options.wheelPositions;
    this.thresholdOverrides = options.detachablePartThresholds;
    this.updateNormals = options.updateNormals ?? true;
  }

  init(config: DamageInitConfig): void {
    this.dispose();
    this.massKg = Math.max(400, Number.isFinite(config.massKg) ? config.massKg : 1450);

    let gMinX = Number.POSITIVE_INFINITY;
    let gMinY = Number.POSITIVE_INFINITY;
    let gMinZ = Number.POSITIVE_INFINITY;
    let gMaxX = Number.NEGATIVE_INFINITY;
    let gMaxY = Number.NEGATIVE_INFINITY;
    let gMaxZ = Number.NEGATIVE_INFINITY;

    for (const payload of config.meshes) {
      const classification = classifyDamagePart(payload.partId, this.thresholdOverrides);
      const spatial = new MeshSpatialIndex(payload.restPositions, this.cellSize);

      const entry: MeshEntry = {
        payload,
        classification,
        spatial,
        restNormals: null,
        maxDisplacement: 0,
        dirty: false,
      };
      this.meshes.push(entry);

      if (spatial.valid) {
        if (spatial.minX < gMinX) gMinX = spatial.minX;
        if (spatial.minY < gMinY) gMinY = spatial.minY;
        if (spatial.minZ < gMinZ) gMinZ = spatial.minZ;
        if (spatial.maxX > gMaxX) gMaxX = spatial.maxX;
        if (spatial.maxY > gMaxY) gMaxY = spatial.maxY;
        if (spatial.maxZ > gMaxZ) gMaxZ = spatial.maxZ;
      }

      let group = this.partGroups.get(classification.logicalId);
      if (!group) {
        group = {
          logicalId: classification.logicalId,
          detachable: classification.detachable,
          thresholdJoules: classification.thresholdJoules,
          accumulatedEnergy: 0,
          detached: false,
          meshes: [],
          center: [0, 0, 0],
          bounds: {
            min: [Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY],
            max: [Number.NEGATIVE_INFINITY, Number.NEGATIVE_INFINITY, Number.NEGATIVE_INFINITY],
          },
        };
        this.partGroups.set(classification.logicalId, group);
      }
      group.meshes.push(entry);
      if (spatial.valid) {
        if (spatial.minX < group.bounds.min[0]) group.bounds.min[0] = spatial.minX;
        if (spatial.minY < group.bounds.min[1]) group.bounds.min[1] = spatial.minY;
        if (spatial.minZ < group.bounds.min[2]) group.bounds.min[2] = spatial.minZ;
        if (spatial.maxX > group.bounds.max[0]) group.bounds.max[0] = spatial.maxX;
        if (spatial.maxY > group.bounds.max[1]) group.bounds.max[1] = spatial.maxY;
        if (spatial.maxZ > group.bounds.max[2]) group.bounds.max[2] = spatial.maxZ;
      }
    }

    for (const group of this.partGroups.values()) {
      if (Number.isFinite(group.bounds.min[0])) {
        group.center = [
          0.5 * (group.bounds.min[0] + group.bounds.max[0]),
          0.5 * (group.bounds.min[1] + group.bounds.max[1]),
          0.5 * (group.bounds.min[2] + group.bounds.max[2]),
        ];
      } else {
        group.bounds = { min: [0, 0, 0], max: [0, 0, 0] };
        group.center = [0, 0, 0];
      }
    }

    if (Number.isFinite(gMinX)) {
      this.vehicleBounds = {
        min: [gMinX, gMinY, gMinZ],
        max: [gMaxX, gMaxY, gMaxZ],
      };
    } else {
      this.vehicleBounds = { min: [-0.95, 0, -2.2], max: [0.95, 1.35, 2.2] };
    }

    const [vMinX, vMinY, vMinZ] = this.vehicleBounds.min;
    const [vMaxX, vMaxY, vMaxZ] = this.vehicleBounds.max;
    const width = Math.max(0.8, vMaxX - vMinX);
    const height = Math.max(0.6, vMaxY - vMinY);
    const length = Math.max(1.6, vMaxZ - vMinZ);
    const midX = 0.5 * (vMinX + vMaxX);
    const midZ = 0.5 * (vMinZ + vMaxZ);

    this.maxVertexDisplacement =
      this.maxVertexDisplacementOverride ?? clamp(length * 0.105, 0.35, 0.55);

    if (this.cabinBoxOverride) {
      this.cabinBox = {
        min: [...this.cabinBoxOverride.min] as Vec3,
        max: [...this.cabinBoxOverride.max] as Vec3,
      };
    } else {
      // Rigid passenger safety cell: inner 60% width, behind firewall to rear bulkhead, floor to headliner.
      this.cabinBox = {
        min: [midX - width * 0.3, vMinY + height * 0.2, midZ - length * 0.24],
        max: [midX + width * 0.3, vMinY + height * 0.85, midZ + length * 0.2],
      };
    }

    if (this.wheelPositionsOverride) {
      this.wheelPositions = [
        [...this.wheelPositionsOverride[0]] as Vec3,
        [...this.wheelPositionsOverride[1]] as Vec3,
        [...this.wheelPositionsOverride[2]] as Vec3,
        [...this.wheelPositionsOverride[3]] as Vec3,
      ];
    } else {
      const wheelX = width * 0.42;
      const wheelY = vMinY + Math.min(0.36, height * 0.28);
      const wheelZ = length * 0.3;
      // Car frame: +Z front, +X left => FL(+X,+Z), FR(-X,+Z), RL(+X,-Z), RR(-X,-Z).
      this.wheelPositions = [
        [midX + wheelX, wheelY, midZ + wheelZ],
        [midX - wheelX, wheelY, midZ + wheelZ],
        [midX + wheelX, wheelY, midZ - wheelZ],
        [midX - wheelX, wheelY, midZ - wheelZ],
      ];
    }

    this.resetDamageCounters();
  }

  applyImpact(event: ImpactEvent): DamageStepResult {
    const impulse = Number.isFinite(event.impulse) ? Math.max(0, event.impulse) : 0;
    const relativeSpeed = Number.isFinite(event.relativeSpeed) ? Math.max(0, event.relativeSpeed) : 0;

    if (impulse < this.minImpulse || relativeSpeed < this.minRelativeSpeed) {
      return this.buildStepResult([], []);
    }

    const [ix, iy, iz] = event.localPoint;
    if (!Number.isFinite(ix) || !Number.isFinite(iy) || !Number.isFinite(iz)) {
      return this.buildStepResult([], []);
    }

    // Throttle redundant 60Hz same-spot scrapes while step(dt) is running, unless a harder hit arrives.
    if (this.hasStepped && this.cooldownSeconds > 0) {
      let writeIdx = 0;
      let throttled = false;
      for (let i = 0; i < this.recentImpacts.length; i++) {
        const hit = this.recentImpacts[i];
        if (this.simTime - hit.time < this.cooldownSeconds) {
          this.recentImpacts[writeIdx++] = hit;
          const dx = ix - hit.x;
          const dy = iy - hit.y;
          const dz = iz - hit.z;
          if (dx * dx + dy * dy + dz * dz <= COOLDOWN_DISTANCE_SQ && impulse <= hit.impulse * 1.25) {
            throttled = true;
          }
        }
      }
      this.recentImpacts.length = writeIdx;
      if (throttled) {
        return this.buildStepResult([], []);
      }
      this.recentImpacts.push({ x: ix, y: iy, z: iz, impulse, time: this.simTime });
    }

    // Normalize inward impact direction (fallback toward vehicle center if zero-length).
    const [vMinX, vMinY, vMinZ] = this.vehicleBounds.min;
    const [vMaxX, vMaxY, vMaxZ] = this.vehicleBounds.max;
    const midX = 0.5 * (vMinX + vMaxX);
    const midY = 0.5 * (vMinY + vMaxY);
    const midZ = 0.5 * (vMinZ + vMaxZ);
    const halfLength = Math.max(0.8, 0.5 * (vMaxZ - vMinZ));
    const halfWidth = Math.max(0.4, 0.5 * (vMaxX - vMinX));

    let nx = event.localNormal[0];
    let ny = event.localNormal[1];
    let nz = event.localNormal[2];
    const nLen = Math.hypot(nx, ny, nz);
    if (nLen > 1e-5) {
      nx /= nLen;
      ny /= nLen;
      nz /= nLen;
    } else {
      const fx = midX - ix;
      const fy = midY - iy;
      const fz = midZ - iz;
      const fLen = Math.hypot(fx, fy, fz);
      if (fLen > 1e-5) {
        nx = fx / fLen;
        ny = fy / fLen;
        nz = fz / fLen;
      } else {
        nx = 0;
        ny = 0;
        nz = -1;
      }
    }

    // Build orthonormal tangent basis (T1, T2) perpendicular to N for sheet-metal buckling/wrinkling.
    let refX = 0;
    let refY = 1;
    let refZ = 0;
    if (Math.abs(ny) > 0.9) {
      refX = 1;
      refY = 0;
    }
    let t1x = refY * nz - refZ * ny;
    let t1y = refZ * nx - refX * nz;
    let t1z = refX * ny - refY * nx;
    const t1Len = Math.hypot(t1x, t1y, t1z) || 1;
    t1x /= t1Len;
    t1y /= t1Len;
    t1z /= t1Len;

    const t2x = ny * t1z - nz * t1y;
    const t2y = nz * t1x - nx * t1z;
    const t2z = nx * t1y - ny * t1x;

    // Impact energy & plastic deformation parameters.
    const deltaV = impulse / this.massKg;
    const impactSpeed = Math.max(relativeSpeed, deltaV);
    const energyJoules = 0.5 * impulse * Math.max(1, impactSpeed);
    const radius = clamp(0.28 + 0.14 * Math.log1p(energyJoules / 4000), 0.28, 1.35);
    const radiusSq = radius * radius;
    const invRadius = 1 / radius;
    const maxDepth = clamp(0.03 + 0.085 * Math.pow(energyJoules / 12000, 0.42), 0.025, 0.36);

    const cMinX = this.cabinBox.min[0];
    const cMinY = this.cabinBox.min[1];
    const cMinZ = this.cabinBox.min[2];
    const cMaxX = this.cabinBox.max[0];
    const cMaxY = this.cabinBox.max[1];
    const cMaxZ = this.cabinBox.max[2];
    const minFloorY = vMinY + 0.02;
    const maxCap = this.maxVertexDisplacement;
    const maxCapSq = maxCap * maxCap;

    const dirtyPartIds: string[] = [];
    const groupEnergyBonus = new Map<PartGroupState, number>();
    let totalMutatedVertices = 0;

    for (let m = 0; m < this.meshes.length; m++) {
      const entry = this.meshes[m];
      const partId = entry.payload.partId;
      const group = this.partGroups.get(entry.classification.logicalId)!;

      if (group.detached) continue;
      if (event.partId && event.partId !== partId && event.partId !== group.logicalId) continue;

      const spatial = entry.spatial;
      const queryRadius = radius + entry.maxDisplacement;
      if (!spatial.overlapsSphere(ix, iy, iz, queryRadius)) continue;

      const rest = entry.payload.restPositions;
      const pos = entry.payload.positions;
      const normals = this.updateNormals ? entry.payload.normals : undefined;
      const hasNormals = normals !== undefined && normals.length >= pos.length;

      let mutatedCount = 0;
      let meshMaxDisp = entry.maxDisplacement;

      // Collect cell ranges or direct range to iterate with zero per-vertex closure overhead.
      let useGridLoop = false;
      let ix0 = 0;
      let ix1 = 0;
      let iy0 = 0;
      let iy1 = 0;
      let iz0 = 0;
      let iz1 = 0;
      if (spatial.useGrid) {
        useGridLoop = true;
        ix0 = Math.floor((ix - queryRadius - spatial.minX) * spatial.invCellX);
        ix1 = Math.floor((ix + queryRadius - spatial.minX) * spatial.invCellX);
        iy0 = Math.floor((iy - queryRadius - spatial.minY) * spatial.invCellY);
        iy1 = Math.floor((iy + queryRadius - spatial.minY) * spatial.invCellY);
        iz0 = Math.floor((iz - queryRadius - spatial.minZ) * spatial.invCellZ);
        iz1 = Math.floor((iz + queryRadius - spatial.minZ) * spatial.invCellZ);

        if (ix0 < 0) ix0 = 0;
        if (ix1 >= spatial.nx) ix1 = spatial.nx - 1;
        if (iy0 < 0) iy0 = 0;
        if (iy1 >= spatial.ny) iy1 = spatial.ny - 1;
        if (iz0 < 0) iz0 = 0;
        if (iz1 >= spatial.nz) iz1 = spatial.nz - 1;
      }

      const gNx = spatial.nx;
      const gNyNx = spatial.ny * gNx;
      const offsets = spatial.cellOffsets;
      const verts = spatial.cellVertices;
      const invHalfLength = 1 / halfLength;
      const invMaxCap = 1 / maxCap;
      const capStop = maxCap - 1e-4;

      let gz = useGridLoop ? iz0 : 0;
      const gzEnd = useGridLoop ? iz1 : 0;

      for (; gz <= gzEnd; gz++) {
        const zBase = gz * gNyNx;
        let gy = useGridLoop ? iy0 : 0;
        const gyEnd = useGridLoop ? iy1 : 0;
        for (; gy <= gyEnd; gy++) {
          const yzBase = zBase + gy * gNx;
          let gx = useGridLoop ? ix0 : 0;
          const gxEnd = useGridLoop ? ix1 : 0;
          for (; gx <= gxEnd; gx++) {
            const start = useGridLoop ? offsets[yzBase + gx] : 0;
            const end = useGridLoop ? offsets[yzBase + gx + 1] : spatial.vertexCount;

            for (let k = start; k < end; k++) {
              const v = useGridLoop ? verts[k] : k;
              const i3 = v * 3;
              const px = pos[i3];
              const py = pos[i3 + 1];
              const pz = pos[i3 + 2];

              const dx = px - ix;
              const dy = py - iy;
              const dz = pz - iz;
              const distSq = dx * dx + dy * dy + dz * dz;
              if (distSq >= radiusSq) continue;

              const rx = rest[i3];
              const ry = rest[i3 + 1];
              const rz = rest[i3 + 2];

              // Keep interior cabin geometry (seats, dash, steering wheel) rigid.
              if (
                rx > cMinX &&
                rx < cMaxX &&
                ry > cMinY &&
                ry < cMaxY &&
                rz > cMinZ &&
                rz < cMaxZ
              ) {
                continue;
              }

              const dist = Math.sqrt(distSq);
              const t = 1 - dist * invRadius; // 1 at impact center, 0 at edge
              const falloff = t * t * (3 - 2 * t); // C1 smoothstep
              if (falloff <= 1e-5) continue;

              // Crumple-zone compliance: front/rear crumple zones yield more readily than mid-cabin.
              const zAbsNorm = Math.abs((rz - midZ) * invHalfLength);
              let compliance: number;
              if (zAbsNorm > 0.35) {
                const fz = (zAbsNorm - 0.35) * 1.5384615;
                compliance = 0.95 + 0.3 * (fz > 1 ? 1 : fz);
              } else {
                compliance = 0.68 + 0.27 * (zAbsNorm * 2.8571428);
              }

              // Cumulative strain hardening: already-crumpled metal resists further collapse.
              const curDx = px - rx;
              const curDy = py - ry;
              const curDz = pz - rz;
              const curDisp = Math.sqrt(curDx * curDx + curDy * curDy + curDz * curDz);
              if (curDisp >= capStop) continue;
              const hardening = 0.25 + 0.75 * (1 - curDisp * invMaxCap);

              const corePush = maxDepth * compliance * falloff * hardening;

              // Fast deterministic material-space sheet-metal buckling/wrinkling (triangle waves in [-1, 1]).
              const ringWeight = 4 * t * (1 - t); // peaks at mid-ring, 0 at center & boundary
              const pA = rx * 3.13 + ry * 2.11 + rz * 2.72;
              const fA = pA - Math.floor(pA);
              const creaseA = (fA < 0.5 ? fA * 4 - 1 : 3 - fA * 4);
              const pB = rx * 1.81 - ry * 3.67 + rz * 2.37;
              const fB = pB - Math.floor(pB);
              const creaseB = (fB < 0.5 ? fB * 4 - 1 : 3 - fB * 4);
              const buckle = creaseA * 0.6 + creaseB * 0.4;

              const inward = corePush * (1 + 0.14 * buckle * (1 - t));
              const lateralScale = corePush * 0.22 * ringWeight;
              const lat1 = lateralScale * creaseA;
              const lat2 = lateralScale * creaseB;

              // Subtle outward rim bulge representing displaced sheet metal folding at the dent lip.
              let rimX = 0;
              let rimY = 0;
              let rimZ = 0;
              if (dist > 1e-4 && ringWeight > 0.05) {
                const invDist = 1 / dist;
                const rdx = dx * invDist;
                const rdy = dy * invDist;
                const rdz = dz * invDist;
                const dotN = rdx * nx + rdy * ny + rdz * nz;
                const rimMag = corePush * 0.08 * ringWeight;
                rimX = (rdx - dotN * nx) * rimMag;
                rimY = (rdy - dotN * ny) * rimMag;
                rimZ = (rdz - dotN * nz) * rimMag;
              }

              let newX = px + nx * inward + t1x * lat1 + t2x * lat2 + rimX;
              let newY = py + ny * inward + t1y * lat1 + t2y * lat2 + rimY;
              let newZ = pz + nz * inward + t1z * lat1 + t2z * lat2 + rimZ;

              // Cumulative displacement cap relative to rest position.
              let totalDx = newX - rx;
              let totalDy = newY - ry;
              let totalDz = newZ - rz;
              const totalDispSq = totalDx * totalDx + totalDy * totalDy + totalDz * totalDz;
              if (totalDispSq > maxCapSq) {
                const scale = maxCap / Math.sqrt(totalDispSq);
                totalDx *= scale;
                totalDy *= scale;
                totalDz *= scale;
                newX = rx + totalDx;
                newY = ry + totalDy;
                newZ = rz + totalDz;
              }

              // Rigid cabin safety cell clamp (exact ray-box entry from rest -> proposed).
              if (
                newX > cMinX &&
                newX < cMaxX &&
                newY > cMinY &&
                newY < cMaxY &&
                newZ > cMinZ &&
                newZ < cMaxZ
              ) {
                const vx = newX - rx;
                const vy = newY - ry;
                const vz = newZ - rz;
                let tHit = -1;

                if (rx <= cMinX && vx > 1e-9) {
                  const tx = (cMinX - rx) / vx;
                  if (tx > tHit) tHit = tx;
                } else if (rx >= cMaxX && vx < -1e-9) {
                  const tx = (cMaxX - rx) / vx;
                  if (tx > tHit) tHit = tx;
                }

                if (ry <= cMinY && vy > 1e-9) {
                  const ty = (cMinY - ry) / vy;
                  if (ty > tHit) tHit = ty;
                } else if (ry >= cMaxY && vy < -1e-9) {
                  const ty = (cMaxY - ry) / vy;
                  if (ty > tHit) tHit = ty;
                }

                if (rz <= cMinZ && vz > 1e-9) {
                  const tz = (cMinZ - rz) / vz;
                  if (tz > tHit) tHit = tz;
                } else if (rz >= cMaxZ && vz < -1e-9) {
                  const tz = (cMaxZ - rz) / vz;
                  if (tz > tHit) tHit = tz;
                }

                if (tHit >= 0 && tHit <= 1) {
                  const tClamped = tHit > 1e-4 ? tHit - 1e-4 : 0;
                  newX = rx + vx * tClamped;
                  newY = ry + vy * tClamped;
                  newZ = rz + vz * tClamped;
                } else {
                  const dMinX = newX - cMinX;
                  const dMaxX = cMaxX - newX;
                  const dMinY = newY - cMinY;
                  const dMaxY = cMaxY - newY;
                  const dMinZ = newZ - cMinZ;
                  const dMaxZ = cMaxZ - newZ;
                  const mDist = Math.min(dMinX, dMaxX, dMinY, dMaxY, dMinZ, dMaxZ);
                  if (mDist === dMinX) newX = cMinX;
                  else if (mDist === dMaxX) newX = cMaxX;
                  else if (mDist === dMinY) newY = cMinY;
                  else if (mDist === dMaxY) newY = cMaxY;
                  else if (mDist === dMinZ) newZ = cMinZ;
                  else newZ = cMaxZ;
                }
              }

              // Anti-inversion guards: never cross vehicle centerline or push below ground plane.
              if (rx > midX + 0.08 && newX < midX + 0.04) newX = midX + 0.04;
              else if (rx < midX - 0.08 && newX > midX - 0.04) newX = midX - 0.04;
              if (rz > midZ + 0.25 && newZ < midZ + 0.05) newZ = midZ + 0.05;
              else if (rz < midZ - 0.25 && newZ > midZ - 0.05) newZ = midZ - 0.05;
              if (ry > minFloorY && newY < minFloorY) newY = minFloorY;

              pos[i3] = newX;
              pos[i3 + 1] = newY;
              pos[i3 + 2] = newZ;

              const fDx = newX - rx;
              const fDy = newY - ry;
              const fDz = newZ - rz;
              const finalDispSq = fDx * fDx + fDy * fDy + fDz * fDz;
              if (finalDispSq > meshMaxDisp * meshMaxDisp) {
                meshMaxDisp = Math.sqrt(finalDispSq);
              }

              // Fast O(1) local normal perturbation when vertex normals buffer is provided.
              if (hasNormals) {
                if (!entry.restNormals) {
                  entry.restNormals = normals!.slice();
                }
                const rawSlope = 6 * t * (1 - t) * (corePush * invRadius) * 2.4;
                const slope = rawSlope > 0.85 ? 0.85 : rawSlope < 0 ? 0 : rawSlope;
                let vnx = normals![i3];
                let vny = normals![i3 + 1];
                let vnz = normals![i3 + 2];
                if (dist > 1e-4) {
                  const invD = 1 / dist;
                  const s35 = slope * 0.35;
                  vnx += dx * invD * slope + t1x * (creaseA * s35) + t2x * (creaseB * s35);
                  vny += dy * invD * slope + t1y * (creaseA * s35) + t2y * (creaseB * s35);
                  vnz += dz * invD * slope + t1z * (creaseA * s35) + t2z * (creaseB * s35);
                }
                const vnLenSq = vnx * vnx + vny * vny + vnz * vnz;
                if (vnLenSq > 1e-10) {
                  const invVnLen = 1 / Math.sqrt(vnLenSq);
                  normals![i3] = vnx * invVnLen;
                  normals![i3 + 1] = vny * invVnLen;
                  normals![i3 + 2] = vnz * invVnLen;
                }
              }

              mutatedCount++;
            }
          }
        }
      }

      if (mutatedCount > 0) {
        entry.dirty = true;
        entry.maxDisplacement = meshMaxDisp;
        dirtyPartIds.push(partId);
        totalMutatedVertices += mutatedCount;

        if (group.detachable) {
          const fraction = mutatedCount / Math.max(1, spatial.vertexCount);
          const share = energyJoules * clamp(0.45 + fraction * 1.1, 0.45, 1.0);
          const prev = groupEnergyBonus.get(group) ?? 0;
          if (share > prev) groupEnergyBonus.set(group, share);
        }
      }
    }

    // Credit proximity impact energy to detachable parts even if their geometry is sparse or hit by explicit partId.
    const newlyDetachedImpulses: DetachedPartImpulse[] = [];
    for (const group of this.partGroups.values()) {
      if (!group.detachable || group.detached) continue;
      let addedEnergy = groupEnergyBonus.get(group) ?? 0;

      if (addedEnergy === 0) {
        const explicitMatch =
          event.partId !== undefined &&
          (event.partId === group.logicalId || group.meshes.some((m) => m.payload.partId === event.partId));
        if (explicitMatch) {
          addedEnergy = energyJoules;
        } else if (this.boundsOverlapSphere(group.bounds, ix, iy, iz, radius * 0.9)) {
          const dist = Math.hypot(
            group.center[0] - ix,
            group.center[1] - iy,
            group.center[2] - iz,
          );
          const prox = clamp(1 - dist / (radius * 1.6), 0, 1);
          addedEnergy = energyJoules * prox * 0.65;
        }
      }

      if (addedEnergy <= 0) continue;
      group.accumulatedEnergy += addedEnergy;

      if (group.accumulatedEnergy >= group.thresholdJoules) {
        group.detached = true;
        this.detachedIds.add(group.logicalId);
        for (const m of group.meshes) {
          this.detachedIds.add(m.payload.partId);
        }

        const [cx, cy, cz] = group.center;
        // Outward vector from vehicle center through part center.
        let outX = cx - midX;
        let outY = Math.max(0.25, cy - midY + 0.35);
        let outZ = cz - midZ;
        const outLen = Math.hypot(outX, outY, outZ) || 1;
        outX /= outLen;
        outY /= outLen;
        outZ /= outLen;

        const launchSpeed = clamp(impactSpeed * 0.42 + deltaV * 0.3, 2.5, 16);
        const launchImpulse: Vec3 = [
          (outX * 0.65 - nx * 0.35) * launchSpeed,
          (0.45 + outY * 0.4) * launchSpeed,
          (outZ * 0.65 - nz * 0.35) * launchSpeed,
        ];

        // Lever arm torque: (partCenter - impactPoint) x N
        const armX = cx - ix;
        const armY = cy - iy;
        const armZ = cz - iz;
        const spinScale = clamp(impactSpeed * 0.35, 2.0, 11.0);
        let angX = (armY * nz - armZ * ny) * spinScale;
        let angY = (armZ * nx - armX * nz) * spinScale;
        let angZ = (armX * ny - armY * nx) * spinScale;
        if (Math.hypot(angX, angY, angZ) < 1.2) {
          angX += 2.5;
          angY += 3.2 * (cx >= midX ? 1 : -1);
          angZ += 1.8;
        }

        newlyDetachedImpulses.push({
          partId: group.logicalId,
          impulse: launchImpulse,
          angularVelocity: [angX, angY, angZ],
          origin: [cx, cy, cz],
        });
      }
    }

    // Update mechanical & lamp health based on impact zone and severity.
    this.applyMechanicalDamage(
      ix,
      iy,
      iz,
      impulse,
      energyJoules,
      radius,
      midX,
      midZ,
      halfWidth,
      halfLength,
      totalMutatedVertices > 0 ? 1 : 0.75,
    );

    return this.buildStepResult(dirtyPartIds, newlyDetachedImpulses);
  }

  step(dtSeconds: number): DamageStepResult {
    if (Number.isFinite(dtSeconds) && dtSeconds > 0) {
      this.simTime += dtSeconds;
      this.hasStepped = true;
    }
    return this.buildStepResult([], []);
  }

  reset(): DamageStepResult {
    const dirtySet = new Set<string>();

    for (let m = 0; m < this.meshes.length; m++) {
      const entry = this.meshes[m];
      const group = this.partGroups.get(entry.classification.logicalId)!;
      if (entry.dirty || group.detached) {
        entry.payload.positions.set(entry.payload.restPositions);
        if (entry.restNormals && entry.payload.normals) {
          entry.payload.normals.set(entry.restNormals);
        }
        entry.dirty = false;
        entry.maxDisplacement = 0;
        dirtySet.add(entry.payload.partId);
      }
    }

    for (const group of this.partGroups.values()) {
      group.detached = false;
      group.accumulatedEnergy = 0;
    }

    this.detachedIds.clear();
    this.resetDamageCounters();

    return this.buildStepResult(Array.from(dirtySet), []);
  }

  dispose(): void {
    this.meshes = [];
    this.partGroups.clear();
    this.detachedIds.clear();
    this.recentImpacts = [];
    this.resetDamageCounters();
  }

  /** Returns a defensive copy of the current mechanical health snapshot. */
  getHealth(): MechanicalHealth {
    return cloneMechanicalHealth(this.health);
  }

  /** Returns the active rigid cabin safety cell bounds in vehicle-local meters. */
  getCabinBox(): DamageBounds {
    return {
      min: [...this.cabinBox.min] as Vec3,
      max: [...this.cabinBox.max] as Vec3,
    };
  }

  /** Returns the computed overall vehicle AABB in vehicle-local meters. */
  getVehicleBounds(): DamageBounds {
    return {
      min: [...this.vehicleBounds.min] as Vec3,
      max: [...this.vehicleBounds.max] as Vec3,
    };
  }

  /** Returns all currently detached part ids. */
  getDetachedPartIds(): string[] {
    return Array.from(this.detachedIds);
  }

  private resetDamageCounters(): void {
    this.health = createHealthyMechanicalHealth();
    this.structuralDamage = 0;
    this.frontLampDamage = 0;
    this.rearLampDamage = 0;
    this.steeringBend = 0;
    this.simTime = 0;
    this.hasStepped = false;
    this.recentImpacts = [];
  }

  private applyMechanicalDamage(
    ix: number,
    iy: number,
    iz: number,
    impulse: number,
    energyJoules: number,
    radius: number,
    midX: number,
    midZ: number,
    halfWidth: number,
    halfLength: number,
    meshContactFactor: number,
  ): void {
    const zNorm = clamp((iz - midZ) / halfLength, -1, 1);
    const xNorm = clamp((ix - midX) / halfWidth, -1, 1);

    const energyFactor = clamp(energyJoules / 140_000, 0, 1);
    const impulseFactor = clamp((impulse - this.minImpulse) / 28_000, 0, 1);
    const damageUnit = clamp(0.55 * energyFactor + 0.45 * impulseFactor, 0.02, 0.85);

    // Front zone (+Z): engine bay + headlights.
    if (zNorm > 0.25) {
      const frontWeight = clamp((zNorm - 0.25) / 0.55, 0, 1);
      const engineLoss = damageUnit * (0.4 + 0.6 * frontWeight);
      this.health.engineHealth = clamp(this.health.engineHealth - engineLoss, 0, 1);

      this.frontLampDamage += damageUnit * (0.5 + 0.5 * frontWeight);
      if ((impulse >= 4500 && zNorm > 0.45) || this.frontLampDamage >= 0.35) {
        this.health.headlightsIntact = false;
      }
    }

    // Rear zone (-Z): taillights + minor exhaust/drivetrain trauma on severe rear hits.
    if (zNorm < -0.25) {
      const rearWeight = clamp((-zNorm - 0.25) / 0.55, 0, 1);
      if (damageUnit > 0.25) {
        this.health.engineHealth = clamp(
          this.health.engineHealth - damageUnit * 0.12 * rearWeight,
          0,
          1,
        );
      }

      this.rearLampDamage += damageUnit * (0.5 + 0.5 * rearWeight);
      if ((impulse >= 4500 && zNorm < -0.45) || this.rearLampDamage >= 0.35) {
        this.health.taillightsIntact = false;
      }
    }

    // Corner impacts degrade the corresponding wheel's integrity [FL, FR, RL, RR].
    const wheelReach = Math.max(1.05, radius * 1.35);
    for (let w = 0; w < 4; w++) {
      const [wx, wy, wz] = this.wheelPositions[w];
      const dist = Math.hypot(ix - wx, iy - wy, iz - wz);
      if (dist < wheelReach) {
        const proximity = 1 - dist / wheelReach;
        const wheelLoss = damageUnit * (0.25 + 0.75 * proximity * proximity);
        this.health.wheelIntegrity[w] = clamp(this.health.wheelIntegrity[w] - wheelLoss, 0, 1);
      }
    }

    // Tie-rod / alignment steering pull (-1..1): asymmetric front-left (+X) damage pulls +1, front-right (-X) pulls -1.
    if (zNorm > 0.1 && Math.abs(xNorm) > 0.2) {
      this.steeringBend = clamp(this.steeringBend + Math.sign(xNorm) * damageUnit * 0.35, -0.6, 0.6);
    }
    const frontAsymmetry = this.health.wheelIntegrity[1] - this.health.wheelIntegrity[0];
    const rearAsymmetry = (this.health.wheelIntegrity[3] - this.health.wheelIntegrity[2]) * 0.3;
    this.health.steeringPull = clamp(frontAsymmetry * 0.75 + rearAsymmetry + this.steeringBend, -1, 1);

    // Overall structural chassis integrity (1.0 = mint, 0.0 = totaled).
    this.structuralDamage = clamp(
      this.structuralDamage + damageUnit * 0.42 * meshContactFactor,
      0,
      1,
    );
    const avgWheel =
      0.25 *
      (this.health.wheelIntegrity[0] +
        this.health.wheelIntegrity[1] +
        this.health.wheelIntegrity[2] +
        this.health.wheelIntegrity[3]);
    const mechanicalFloor = 0.65 * (1 - this.structuralDamage) + 0.2 * this.health.engineHealth + 0.15 * avgWheel;
    this.health.chassisIntegrity = clamp(Math.min(1 - this.structuralDamage, mechanicalFloor), 0, 1);
  }

  private boundsOverlapSphere(
    bounds: DamageBounds,
    cx: number,
    cy: number,
    cz: number,
    radius: number,
  ): boolean {
    let dx = 0;
    if (cx < bounds.min[0]) dx = bounds.min[0] - cx;
    else if (cx > bounds.max[0]) dx = cx - bounds.max[0];

    let dy = 0;
    if (cy < bounds.min[1]) dy = bounds.min[1] - cy;
    else if (cy > bounds.max[1]) dy = cy - bounds.max[1];

    let dz = 0;
    if (cz < bounds.min[2]) dz = bounds.min[2] - cz;
    else if (cz > bounds.max[2]) dz = cz - bounds.max[2];

    return dx * dx + dy * dy + dz * dz <= radius * radius;
  }

  private buildStepResult(
    dirtyPartIds: string[],
    detachedImpulses: DetachedPartImpulse[],
  ): DamageStepResult {
    return {
      dirtyPartIds,
      detachedPartIds: Array.from(this.detachedIds),
      detachedImpulses,
      health: cloneMechanicalHealth(this.health),
    };
  }
}
