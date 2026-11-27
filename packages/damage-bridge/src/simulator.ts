import type { Vec3 } from '@blend-garage/vehicle-core';
import { classifyDamagePart, type PartClassification } from './parts.js';
import {
  buildVertexTriangleAdjacency,
  MeshSpatialIndex,
  type VertexTriangleAdjacency,
} from './spatialGrid.js';
import {
  cloneMechanicalHealth,
  createHealthyMechanicalHealth,
  type DamageBounds,
  type DamageInitConfig,
  type DamageSimulator,
  type DamageStepResult,
  type DeformableMeshPayload,
  type DetachedPartEvent,
  type DetachedPartImpulse,
  type ImpactEvent,
  type MechanicalHealth,
  type MeshDamageUpdate,
  type RealDamageSimulatorOptions,
} from './types.js';

/** Maximum vertex count for lazy exact triangle-adjacency normal recomputation. */
const ADJACENCY_VERTEX_LIMIT = 350_000;
/** Above this vertex count, use sparse original-normal backup instead of full Float32Array.slice(). */
const DENSE_NORMAL_BACKUP_LIMIT = 250_000;

interface MeshEntry {
  payload: DeformableMeshPayload;
  classification: PartClassification;
  spatial: MeshSpatialIndex;
  /** Full original-normal snapshot for <= 250k vertex meshes. */
  restNormalsDense: Float32Array | null;
  /** Sparse original-normal backup (typed arrays, zero GC) for mega-poly (> 250k vert) meshes. */
  restNormalsSparseBitset: Uint8Array | null;
  restNormalsSparseIndices: Uint32Array | null;
  restNormalsSparseValues: Float32Array | null;
  restNormalsSparseCount: number;
  /** Lazily built CSR vertex->triangle adjacency when `payload.indices` is supplied. */
  adjacency: VertexTriangleAdjacency | null;
  adjacencyAttempted: boolean;
  /** Per-vertex paint scuff / crease intensity mask (0..1), lazily allocated if not supplied. */
  damageIntensity: Float32Array | null;
  /** Maximum Euclidean displacement currently reached by any vertex in this mesh. */
  maxDisplacement: number;
  /** Whether this mesh's vertex buffer has been mutated since init/reset. */
  dirty: boolean;
  /** Tracked dirty vertex bounds across all impacts since init/reset (for fast reset). */
  dirtyMinEver: number;
  dirtyMaxEver: number;
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
const DEFAULT_CELL_SIZE = 0.22;
const COOLDOWN_DISTANCE_SQ = 0.35 * 0.35;

/**
 * High-performance 60-fps crash damage & accordion crumple-zone vertex deformation simulator.
 *
 * Designed for high-poly vehicles (250k–10M triangles):
 * - Uses per-mesh O(1) AABB rejection + flat CSR 3D spatial grids so `applyImpact()`
 *   touches only vertices inside the impact zone in milliseconds.
 * - Models visceral BeamNG-style accordion front/rear crumpling (0.25–0.65m at high speed),
 *   volume-conserving upward hood/trunk tent buckling, outward fender flare, elongated side
 *   scraping creases, multi-scale sheet-metal crinkling, strain hardening, and a rigid cabin
 *   safety cell clamp that prevents cabin intrusion and inside-out inversion.
 * - Computes exact O(k) local creased face normals when `indices` are supplied (or sharp
 *   analytical crease-gradient normals otherwise) plus a per-vertex `damageIntensity` (0..1)
 *   scuff/crease mask for paint scratching and exposed primer shading.
 * - Tracks per-part accumulated crash energy to detach bumpers, spoilers, mirrors, hoods,
 *   fenders, and doors with physical launch impulses (`detachedParts` + `detachedImpulses`).
 * - Degrades engine, lamps, per-corner structural wheel/axle damage (`wheelDamage`: camber,
 *   toe, wobble, collapsed suspension), steering pull, and overall chassis integrity.
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
  private meshById = new Map<string, MeshEntry>();
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
  private maxVertexDisplacement = 0.68;

  private health: MechanicalHealth = createHealthyMechanicalHealth();
  private structuralDamage = 0;
  private frontLampDamage = 0;
  private rearLampDamage = 0;
  private steeringBend = 0;

  private simTime = 0;
  private hasStepped = false;
  private recentImpacts: RecentImpact[] = [];

  /** Reusable scratch buffer holding vertex indices mutated in the current mesh during `applyImpact`. */
  private touchedScratch = new Uint32Array(4096);

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
        restNormalsDense: null,
        restNormalsSparseBitset: null,
        restNormalsSparseIndices: null,
        restNormalsSparseValues: null,
        restNormalsSparseCount: 0,
        adjacency: null,
        adjacencyAttempted: false,
        damageIntensity: payload.damageIntensity ?? null,
        maxDisplacement: 0,
        dirty: false,
        dirtyMinEver: spatial.vertexCount,
        dirtyMaxEver: -1,
      };
      this.meshes.push(entry);
      this.meshById.set(payload.partId, entry);

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

    // Allow deep, unmistakable 0.55–0.75m front/rear accordion crush on severe crashes.
    this.maxVertexDisplacement =
      this.maxVertexDisplacementOverride ?? clamp(length * 0.155, 0.52, 0.76);

    if (this.cabinBoxOverride) {
      this.cabinBox = {
        min: [...this.cabinBoxOverride.min] as Vec3,
        max: [...this.cabinBoxOverride.max] as Vec3,
      };
    } else {
      // Rigid passenger safety cell: inner 58% width, behind firewall to rear bulkhead, floor to headliner.
      this.cabinBox = {
        min: [midX - width * 0.29, vMinY + height * 0.2, midZ - length * 0.23],
        max: [midX + width * 0.29, vMinY + height * 0.85, midZ + length * 0.19],
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
      return this.buildStepResult([], [], [], []);
    }

    const [ix, iy, iz] = event.localPoint;
    if (!Number.isFinite(ix) || !Number.isFinite(iy) || !Number.isFinite(iz)) {
      return this.buildStepResult([], [], [], []);
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
        return this.buildStepResult([], [], [], []);
      }
      this.recentImpacts.push({ x: ix, y: iy, z: iz, impulse, time: this.simTime });
    }

    const [vMinX, vMinY, vMinZ] = this.vehicleBounds.min;
    const [vMaxX, vMaxY, vMaxZ] = this.vehicleBounds.max;
    const width = Math.max(0.8, vMaxX - vMinX);
    const height = Math.max(0.6, vMaxY - vMinY);
    const midX = 0.5 * (vMinX + vMaxX);
    const midY = 0.5 * (vMinY + vMaxY);
    const midZ = 0.5 * (vMinZ + vMaxZ);
    const halfLength = Math.max(0.8, 0.5 * (vMaxZ - vMinZ));
    const halfWidth = Math.max(0.4, 0.5 * width);

    // Normalize inward impact direction (fallback toward vehicle center if zero-length).
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

    // Physically scaled impact energy, crush radius, and accordion depth.
    const deltaV = impulse / this.massKg;
    const impactSpeed = Math.max(relativeSpeed, deltaV);
    const energyJoules = 0.5 * impulse * Math.max(1.5, impactSpeed);
    const radius = clamp(0.4 + 0.22 * Math.log1p(energyJoules / 4500), 0.36, 1.6);
    const radiusSq = radius * radius;
    const invRadius = 1 / radius;
    const maxDepth = clamp(0.045 + 0.145 * Math.pow(energyJoules / 12_000, 0.44), 0.04, 0.62);

    // Directional impact decomposition for volume-conserving accordion deformation:
    // - frontCrush > 0 when nose (+Z) is pushed backward (-Z) -> hood tents upward + fenders flare out
    // - rearCrush  > 0 when tail (-Z) is pushed forward (+Z) -> trunk tents upward + rear quarters flare
    // - sideScrape > 0 when hitting/scraping flanks (±X) -> elongated longitudinal scrape crease along Z
    const frontCrush = nz < -0.35 ? clamp((-nz - 0.35) / 0.65, 0, 1) : 0;
    const rearCrush = nz > 0.35 ? clamp((nz - 0.35) / 0.65, 0, 1) : 0;
    const longitudinalCrush = frontCrush > rearCrush ? frontCrush : rearCrush;
    const absNx = Math.abs(nx);
    const sideScrape = absNx > 0.45 ? clamp((absNx - 0.45) / 0.55, 0, 1) : 0;
    const scrapeElongZ = 1 + sideScrape * 0.65 * clamp(impactSpeed / 22, 0.25, 1.0);
    const invScrapeElongZ = 1 / scrapeElongZ;
    const speedScuffFactor = clamp(impactSpeed / 16, 0.32, 1.0);

    const cMinX = this.cabinBox.min[0];
    const cMinY = this.cabinBox.min[1];
    const cMinZ = this.cabinBox.min[2];
    const cMaxX = this.cabinBox.max[0];
    const cMaxY = this.cabinBox.max[1];
    const cMaxZ = this.cabinBox.max[2];
    const minFloorY = vMinY + 0.02;
    const hoodFloorY = midY - height * 0.1;
    const frontZoneSpan = Math.max(0.25, vMaxZ - cMaxZ);
    const rearZoneSpan = Math.max(0.25, cMinZ - vMinZ);
    const invFrontZoneSpan = 1 / frontZoneSpan;
    const invRearZoneSpan = 1 / rearZoneSpan;
    const fenderFlareX = width * 0.24;

    const maxCap = this.maxVertexDisplacement;
    const maxCapSq = maxCap * maxCap;
    const invHalfLength = 1 / halfLength;
    const invMaxCap = 1 / maxCap;
    const capStop = maxCap - 1e-4;

    const dirtyPartIds: string[] = [];
    const meshUpdates: MeshDamageUpdate[] = [];
    const groupEnergyBonus = new Map<PartGroupState, number>();
    let totalMutatedVertices = 0;

    for (let m = 0; m < this.meshes.length; m++) {
      const entry = this.meshes[m];
      const partId = entry.payload.partId;
      const group = this.partGroups.get(entry.classification.logicalId)!;

      if (group.detached) continue;
      if (event.partId && event.partId !== partId && event.partId !== group.logicalId) continue;

      const spatial = entry.spatial;
      const queryRadiusX = radius + entry.maxDisplacement;
      const queryRadiusY = radius + entry.maxDisplacement;
      const queryRadiusZ = radius * scrapeElongZ + entry.maxDisplacement;

      if (
        !spatial.overlapsBox(
          ix - queryRadiusX,
          iy - queryRadiusY,
          iz - queryRadiusZ,
          ix + queryRadiusX,
          iy + queryRadiusY,
          iz + queryRadiusZ,
        )
      ) {
        continue;
      }

      const rest = entry.payload.restPositions;
      const pos = entry.payload.positions;
      const normals = this.updateNormals ? entry.payload.normals : undefined;
      const hasNormals = normals !== undefined && normals.length >= pos.length;
      const indices = entry.payload.indices;
      const useExactTriNormals =
        hasNormals &&
        indices !== undefined &&
        indices.length >= 3 &&
        spatial.vertexCount <= ADJACENCY_VERTEX_LIMIT;

      // Hoist normal-backup buffers into locals before hot loop to eliminate per-vertex property lookups.
      const isDenseNormalBackup = spatial.vertexCount <= DENSE_NORMAL_BACKUP_LIMIT;
      let sparseBitset = entry.restNormalsSparseBitset;
      let sparseIdx = entry.restNormalsSparseIndices;
      let sparseVal = entry.restNormalsSparseValues;
      let sparseCount = entry.restNormalsSparseCount;
      if (hasNormals && !useExactTriNormals) {
        if (isDenseNormalBackup) {
          if (!entry.restNormalsDense) {
            entry.restNormalsDense = normals!.slice();
          }
        } else if (!sparseBitset) {
          sparseBitset = new Uint8Array((spatial.vertexCount + 7) >> 3);
          sparseIdx = new Uint32Array(16384);
          sparseVal = new Float32Array(16384 * 3);
          sparseCount = 0;
          entry.restNormalsSparseBitset = sparseBitset;
          entry.restNormalsSparseIndices = sparseIdx;
          entry.restNormalsSparseValues = sparseVal;
          entry.restNormalsSparseCount = 0;
        }
      }

      // Prepare damageIntensity lazily once a vertex actually mutates.
      let dmgMask = entry.damageIntensity;
      let mutatedCount = 0;
      let dirtyMin = spatial.vertexCount;
      let dirtyMax = -1;
      let meshMaxDisp = entry.maxDisplacement;

      // Determine spatial grid cell bounds.
      let useGridLoop = false;
      let ix0 = 0;
      let ix1 = 0;
      let iy0 = 0;
      let iy1 = 0;
      let iz0 = 0;
      let iz1 = 0;
      if (spatial.useGrid) {
        useGridLoop = true;
        ix0 = Math.floor((ix - queryRadiusX - spatial.minX) * spatial.invCellX);
        ix1 = Math.floor((ix + queryRadiusX - spatial.minX) * spatial.invCellX);
        iy0 = Math.floor((iy - queryRadiusY - spatial.minY) * spatial.invCellY);
        iy1 = Math.floor((iy + queryRadiusY - spatial.minY) * spatial.invCellY);
        iz0 = Math.floor((iz - queryRadiusZ - spatial.minZ) * spatial.invCellZ);
        iz1 = Math.floor((iz + queryRadiusZ - spatial.minZ) * spatial.invCellZ);

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
              // Ellipsoidal distance elongates glancing side scrapes along Z without affecting head-on spheres.
              const dzScaled = dz * invScrapeElongZ;
              const distSq = dx * dx + dy * dy + dzScaled * dzScaled;
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

              // Crumple-zone compliance: front/rear crumple zones yield strongly (1.10..1.42),
              // mid-cabin beltline is stiffer (0.62..0.95) while doors still cave in cleanly.
              const zAbsNorm = Math.abs((rz - midZ) * invHalfLength);
              let compliance: number;
              if (zAbsNorm > 0.35) {
                const fz = (zAbsNorm - 0.35) * 1.5384615;
                compliance = 1.05 + 0.35 * (fz > 1 ? 1 : fz);
              } else {
                compliance = 0.65 + 0.4 * (zAbsNorm * 2.8571428);
              }

              // Cumulative strain hardening: already-crumpled metal resists further collapse.
              const curDx = px - rx;
              const curDy = py - ry;
              const curDz = pz - rz;
              const curDispSq = curDx * curDx + curDy * curDy + curDz * curDz;
              const curDisp = curDispSq > 1e-10 ? Math.sqrt(curDispSq) : 0;
              if (curDisp >= capStop) continue;
              const hardening = 0.22 + 0.78 * (1 - curDisp * invMaxCap);

              const corePush = maxDepth * compliance * falloff * hardening;

              // Multi-scale deterministic material-space sheet-metal folds & sharp crinkles (triangle waves in [-1, 1]).
              const ringWeight = 4 * t * (1 - t); // peaks at mid-ring, 0 at center & boundary
              // Coarse structural fold (~0.32m wavelength)
              const pCoarse = rx * 2.17 + ry * 1.73 + rz * 2.41;
              const fCoarse = pCoarse - Math.floor(pCoarse);
              const foldCoarse = fCoarse < 0.5 ? fCoarse * 4 - 1 : 3 - fCoarse * 4;
              // Fine crinkled sheet-metal crease (~0.13m wavelength)
              const pFineA = rx * 4.71 + ry * 3.19 + rz * 4.13;
              const fFineA = pFineA - Math.floor(pFineA);
              const creaseA = fFineA < 0.5 ? fFineA * 4 - 1 : 3 - fFineA * 4;
              const pFineB = rx * 2.83 - ry * 5.29 + rz * 3.57;
              const fFineB = pFineB - Math.floor(pFineB);
              const creaseB = fFineB < 0.5 ? fFineB * 4 - 1 : 3 - fFineB * 4;

              const buckle = foldCoarse * 0.5 + creaseA * 0.3 + creaseB * 0.2;

              // Inward accordion crush + mid-ring crease modulation.
              const inward = corePush * (1 + 0.24 * buckle * (1 - t));
              const lateralScale = corePush * (0.28 + 0.14 * sideScrape) * ringWeight;
              const lat1 = lateralScale * (foldCoarse * 0.55 + creaseA * 0.45);
              const lat2 = lateralScale * (creaseB * 0.65 - foldCoarse * 0.35);

              // Volume conservation:
              // 1) Upward hood / trunk tent buckling & transverse accordion kinks on front/rear crashes.
              let buckleY = 0;
              let flareX = 0;
              if (frontCrush > 0 && rz > cMaxZ - 0.12) {
                const hoodFrac = clamp((rz - (cMaxZ - 0.12)) * invFrontZoneSpan, 0, 1);
                if (ry > hoodFloorY) {
                  // Smooth tent peak mid-hood (4 * u * (1 - u)) + transverse accordion kink waves.
                  const tent = 4 * hoodFrac * (1 - hoodFrac);
                  const kinkPhase = rz * 2.8;
                  const kinkFrac = kinkPhase - Math.floor(kinkPhase);
                  const kinkWave = kinkFrac < 0.5 ? kinkFrac * 2 : 2 - kinkFrac * 2;
                  const heightBias = clamp((ry - hoodFloorY) / (height * 0.42), 0.25, 1.0);
                  buckleY = corePush * frontCrush * heightBias * (0.44 * tent + 0.18 * kinkWave * ringWeight);
                }
                const relX = rx - midX;
                if (Math.abs(relX) > fenderFlareX) {
                  flareX = (relX >= 0 ? 1 : -1) * corePush * frontCrush * 0.28 * (0.35 + 0.65 * ringWeight);
                }
              } else if (rearCrush > 0 && rz < cMinZ + 0.12) {
                const trunkFrac = clamp(((cMinZ + 0.12) - rz) * invRearZoneSpan, 0, 1);
                if (ry > hoodFloorY) {
                  const tent = 4 * trunkFrac * (1 - trunkFrac);
                  const kinkPhase = rz * 2.8;
                  const kinkFrac = kinkPhase - Math.floor(kinkPhase);
                  const kinkWave = kinkFrac < 0.5 ? kinkFrac * 2 : 2 - kinkFrac * 2;
                  const heightBias = clamp((ry - hoodFloorY) / (height * 0.42), 0.25, 1.0);
                  buckleY = corePush * rearCrush * heightBias * (0.38 * tent + 0.16 * kinkWave * ringWeight);
                }
                const relX = rx - midX;
                if (Math.abs(relX) > fenderFlareX) {
                  flareX = (relX >= 0 ? 1 : -1) * corePush * rearCrush * 0.26 * (0.35 + 0.65 * ringWeight);
                }
              }

              // 2) Glancing side scrape horizontal gouge ridge along door/quarter beltline.
              let scrapeX = 0;
              if (sideScrape > 0 && ringWeight > 0.05) {
                const beltPhase = ry * 6.2 + rz * 0.85;
                const beltFrac = beltPhase - Math.floor(beltPhase);
                const beltRidge = beltFrac < 0.5 ? beltFrac * 4 - 1 : 3 - beltFrac * 4;
                scrapeX = nx * corePush * sideScrape * 0.22 * beltRidge * ringWeight;
              }

              // 3) Outward displaced-metal lip bulge at dent rim.
              let rimX = 0;
              let rimY = 0;
              let rimZ = 0;
              if (dist > 1e-4 && ringWeight > 0.05) {
                const invDist = 1 / dist;
                const rdx = dx * invDist;
                const rdy = dy * invDist;
                const rdz = dz * invDist;
                const dotN = rdx * nx + rdy * ny + rdz * nz;
                const rimMag = corePush * (0.12 + 0.06 * longitudinalCrush) * ringWeight;
                rimX = (rdx - dotN * nx) * rimMag;
                rimY = (rdy - dotN * ny) * rimMag;
                rimZ = (rdz - dotN * nz) * rimMag;
              }

              let newX = px + nx * inward + t1x * lat1 + t2x * lat2 + rimX + flareX + scrapeX;
              let newY = py + ny * inward + t1y * lat1 + t2y * lat2 + rimY + buckleY;
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
              const finalDisp = Math.sqrt(finalDispSq);
              if (finalDisp > meshMaxDisp) {
                meshMaxDisp = finalDisp;
              }

              // Lazily allocate per-vertex damage/scuff intensity mask on first vertex mutation.
              if (!dmgMask) {
                dmgMask = new Float32Array(spatial.vertexCount);
                entry.damageIntensity = dmgMask;
              }
              const dispRatio = finalDisp * invMaxCap * 1.85;
              const creaseBonus = Math.abs(buckle) * ringWeight * 0.48 + (buckleY > 0.01 ? 0.25 : 0);
              const rawScuff = (dispRatio * 0.85 + falloff * (0.28 + creaseBonus) * speedScuffFactor);
              const scuff = rawScuff > 1 ? 1 : rawScuff;
              if (scuff > dmgMask[v]) dmgMask[v] = scuff;

              // Track dirty vertex range & mutated vertex list for O(k) normal recomputation.
              if (v < dirtyMin) dirtyMin = v;
              if (v > dirtyMax) dirtyMax = v;

              if (useExactTriNormals) {
                if (mutatedCount >= this.touchedScratch.length) {
                  const grown = new Uint32Array(this.touchedScratch.length * 2);
                  grown.set(this.touchedScratch);
                  this.touchedScratch = grown;
                }
                this.touchedScratch[mutatedCount] = v;
              } else if (hasNormals) {
                // Fast O(1) sharp analytical creased normal perturbation for mega-poly or unindexed meshes.
                if (!isDenseNormalBackup) {
                  const byteIdx = v >> 3;
                  const bit = 1 << (v & 7);
                  if ((sparseBitset![byteIdx] & bit) === 0) {
                    sparseBitset![byteIdx] |= bit;
                    if (sparseCount >= sparseIdx!.length) {
                      const nextCap = sparseIdx!.length * 2;
                      const grownIdx = new Uint32Array(nextCap);
                      grownIdx.set(sparseIdx!);
                      const grownVal = new Float32Array(nextCap * 3);
                      grownVal.set(sparseVal!);
                      sparseIdx = grownIdx;
                      sparseVal = grownVal;
                      entry.restNormalsSparseIndices = grownIdx;
                      entry.restNormalsSparseValues = grownVal;
                    }
                    sparseIdx![sparseCount] = v;
                    const sv3 = sparseCount * 3;
                    sparseVal![sv3] = normals![i3];
                    sparseVal![sv3 + 1] = normals![i3 + 1];
                    sparseVal![sv3 + 2] = normals![i3 + 2];
                    sparseCount++;
                  }
                }
                const rawSlope = 6 * t * (1 - t) * (corePush * invRadius) * 3.4;
                const slope = rawSlope > 0.95 ? 0.95 : rawSlope < 0 ? 0 : rawSlope;
                const foldSlope = (0.35 + 0.55 * falloff) * clamp(corePush * 4.5, 0.08, 0.95);
                let vnx = normals![i3];
                let vny = normals![i3 + 1];
                let vnz = normals![i3 + 2];
                if (dist > 1e-4) {
                  const invD = 1 / dist;
                  const c1 = (foldCoarse * 0.65 + creaseA * 0.35) * foldSlope;
                  const c2 = (creaseB * 0.65 - foldCoarse * 0.35) * foldSlope;
                  vnx += dx * invD * slope + t1x * c1 + t2x * c2;
                  vny += dy * invD * slope + t1y * c1 + t2y * c2 + (buckleY > 0.01 ? -0.35 * foldCoarse * foldSlope : 0);
                  vnz += dz * invD * slope + t1z * c1 + t2z * c2;
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

      if (hasNormals && !useExactTriNormals && !isDenseNormalBackup) {
        entry.restNormalsSparseCount = sparseCount;
      }

      if (mutatedCount > 0) {
        // Exact O(k) local triangle-recomputed creased normals when index buffer is available.
        if (useExactTriNormals) {
          this.recomputeLocalTriangleNormals(entry, normals!, indices!, pos, mutatedCount);
        }

        entry.dirty = true;
        entry.maxDisplacement = meshMaxDisp;
        if (dirtyMin < entry.dirtyMinEver) entry.dirtyMinEver = dirtyMin;
        if (dirtyMax > entry.dirtyMaxEver) entry.dirtyMaxEver = dirtyMax;

        dirtyPartIds.push(partId);
        if (dmgMask) {
          meshUpdates.push({
            partId,
            damageIntensity: dmgMask,
            dirtyVertexMin: dirtyMin,
            dirtyVertexMax: dirtyMax,
            mutatedCount,
          });
        }
        totalMutatedVertices += mutatedCount;

        if (group.detachable) {
          const fraction = mutatedCount / Math.max(1, spatial.vertexCount);
          const share = energyJoules * clamp(0.5 + fraction * 1.15, 0.5, 1.0);
          const prev = groupEnergyBonus.get(group) ?? 0;
          if (share > prev) groupEnergyBonus.set(group, share);
        }
      }
    }

    // Credit proximity impact energy to detachable parts even if their geometry is sparse or hit by explicit partId.
    const newlyDetachedImpulses: DetachedPartImpulse[] = [];
    const newlyDetachedParts: DetachedPartEvent[] = [];

    for (const group of this.partGroups.values()) {
      if (!group.detachable || group.detached) continue;
      let addedEnergy = groupEnergyBonus.get(group) ?? 0;

      if (addedEnergy === 0) {
        const explicitMatch =
          event.partId !== undefined &&
          (event.partId === group.logicalId || group.meshes.some((m) => m.payload.partId === event.partId));
        if (explicitMatch) {
          addedEnergy = energyJoules;
        } else if (this.boundsOverlapSphere(group.bounds, ix, iy, iz, radius * 0.95)) {
          const dist = Math.hypot(
            group.center[0] - ix,
            group.center[1] - iy,
            group.center[2] - iz,
          );
          const prox = clamp(1 - dist / (radius * 1.65), 0, 1);
          addedEnergy = energyJoules * prox * 0.72;
        }
      }

      if (addedEnergy <= 0) continue;
      group.accumulatedEnergy += addedEnergy;

      if (group.accumulatedEnergy >= group.thresholdJoules) {
        group.detached = true;
        this.detachedIds.add(group.logicalId);
        const meshIds: string[] = [];
        for (const m of group.meshes) {
          this.detachedIds.add(m.payload.partId);
          meshIds.push(m.payload.partId);
        }

        const [cx, cy, cz] = group.center;
        // Outward vector from vehicle center through part center.
        let outX = cx - midX;
        let outY = Math.max(0.3, cy - midY + 0.42);
        let outZ = cz - midZ;
        const outLen = Math.hypot(outX, outY, outZ) || 1;
        outX /= outLen;
        outY /= outLen;
        outZ /= outLen;

        const launchSpeed = clamp(impactSpeed * 0.48 + deltaV * 0.32, 3.2, 18);
        const launchImpulse: [number, number, number] = [
          (outX * 0.65 - nx * 0.35) * launchSpeed,
          (0.5 + outY * 0.45) * launchSpeed,
          (outZ * 0.65 - nz * 0.35) * launchSpeed,
        ];

        // Lever arm torque: (partCenter - impactPoint) x N
        const armX = cx - ix;
        const armY = cy - iy;
        const armZ = cz - iz;
        const spinScale = clamp(impactSpeed * 0.42, 2.5, 13.0);
        let angX = (armY * nz - armZ * ny) * spinScale;
        let angY = (armZ * nx - armX * nz) * spinScale;
        let angZ = (armX * ny - armY * nx) * spinScale;
        if (Math.hypot(angX, angY, angZ) < 1.8) {
          angX += 3.0;
          angY += 3.8 * (cx >= midX ? 1 : -1);
          angZ += 2.2;
        }
        const angularVelocity: [number, number, number] = [angX, angY, angZ];

        newlyDetachedImpulses.push({
          partId: group.logicalId,
          impulse: launchImpulse,
          angularVelocity,
          origin: [cx, cy, cz],
        });
        newlyDetachedParts.push({
          partId: group.logicalId,
          meshIds,
          impulse: launchImpulse,
          angularVelocity,
        });
      }
    }

    // Update mechanical, lamp, and per-corner structural wheel/axle damage.
    this.applyMechanicalDamage(
      ix,
      iy,
      iz,
      nx,
      nz,
      impulse,
      energyJoules,
      radius,
      midX,
      midZ,
      halfWidth,
      halfLength,
      totalMutatedVertices > 0 ? 1 : 0.75,
    );

    return this.buildStepResult(dirtyPartIds, newlyDetachedImpulses, newlyDetachedParts, meshUpdates);
  }

  step(dtSeconds: number): DamageStepResult {
    if (Number.isFinite(dtSeconds) && dtSeconds > 0) {
      this.simTime += dtSeconds;
      this.hasStepped = true;
    }
    return this.buildStepResult([], [], [], []);
  }

  reset(): DamageStepResult {
    const dirtySet = new Set<string>();
    const meshUpdates: MeshDamageUpdate[] = [];

    for (let m = 0; m < this.meshes.length; m++) {
      const entry = this.meshes[m];
      const group = this.partGroups.get(entry.classification.logicalId)!;
      if (entry.dirty || group.detached) {
        entry.payload.positions.set(entry.payload.restPositions);

        if (entry.payload.normals) {
          if (entry.restNormalsDense) {
            entry.payload.normals.set(entry.restNormalsDense);
          } else if (entry.restNormalsSparseIndices && entry.restNormalsSparseValues) {
            const norms = entry.payload.normals;
            const sIdx = entry.restNormalsSparseIndices;
            const sVal = entry.restNormalsSparseValues;
            const sCount = entry.restNormalsSparseCount;
            for (let k = 0; k < sCount; k++) {
              const i3 = sIdx[k] * 3;
              const v3 = k * 3;
              norms[i3] = sVal[v3];
              norms[i3 + 1] = sVal[v3 + 1];
              norms[i3 + 2] = sVal[v3 + 2];
            }
            if (entry.restNormalsSparseBitset) entry.restNormalsSparseBitset.fill(0);
            entry.restNormalsSparseCount = 0;
          }
        }

        if (entry.damageIntensity) {
          if (entry.dirtyMaxEver >= entry.dirtyMinEver && entry.dirtyMinEver >= 0) {
            entry.damageIntensity.fill(0, entry.dirtyMinEver, entry.dirtyMaxEver + 1);
          } else {
            entry.damageIntensity.fill(0);
          }
          meshUpdates.push({
            partId: entry.payload.partId,
            damageIntensity: entry.damageIntensity,
            dirtyVertexMin: Math.min(entry.dirtyMinEver, Math.max(0, entry.spatial.vertexCount - 1)),
            dirtyVertexMax: Math.max(0, entry.dirtyMaxEver),
            mutatedCount: 0,
          });
        }

        entry.dirty = false;
        entry.maxDisplacement = 0;
        entry.dirtyMinEver = entry.spatial.vertexCount;
        entry.dirtyMaxEver = -1;
        dirtySet.add(entry.payload.partId);
      }
    }

    for (const group of this.partGroups.values()) {
      group.detached = false;
      group.accumulatedEnergy = 0;
    }

    this.detachedIds.clear();
    this.resetDamageCounters();

    return this.buildStepResult(Array.from(dirtySet), [], [], meshUpdates);
  }

  dispose(): void {
    this.meshes = [];
    this.meshById.clear();
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

  /** Returns the per-vertex damage/scuff intensity buffer (0..1) for a mesh if it has been hit (or pre-supplied). */
  getDamageIntensity(partId: string): Float32Array | null {
    return this.meshById.get(partId)?.damageIntensity ?? null;
  }

  private backupVertexNormal(entry: MeshEntry, normals: Float32Array, v: number, i3: number): void {
    if (entry.spatial.vertexCount <= DENSE_NORMAL_BACKUP_LIMIT) {
      if (!entry.restNormalsDense) {
        entry.restNormalsDense = normals.slice();
      }
      return;
    }

    let bitset = entry.restNormalsSparseBitset;
    if (!bitset) {
      bitset = new Uint8Array((entry.spatial.vertexCount + 7) >> 3);
      entry.restNormalsSparseBitset = bitset;
      entry.restNormalsSparseIndices = new Uint32Array(16384);
      entry.restNormalsSparseValues = new Float32Array(16384 * 3);
      entry.restNormalsSparseCount = 0;
    }
    const byteIdx = v >> 3;
    const bit = 1 << (v & 7);
    if ((bitset[byteIdx] & bit) === 0) {
      bitset[byteIdx] |= bit;
      const sc = entry.restNormalsSparseCount;
      let sIdx = entry.restNormalsSparseIndices!;
      let sVal = entry.restNormalsSparseValues!;
      if (sc >= sIdx.length) {
        const nextCap = sIdx.length * 2;
        const grownIdx = new Uint32Array(nextCap);
        grownIdx.set(sIdx);
        const grownVal = new Float32Array(nextCap * 3);
        grownVal.set(sVal);
        entry.restNormalsSparseIndices = grownIdx;
        entry.restNormalsSparseValues = grownVal;
        sIdx = grownIdx;
        sVal = grownVal;
      }
      sIdx[sc] = v;
      const sv3 = sc * 3;
      sVal[sv3] = normals[i3];
      sVal[sv3 + 1] = normals[i3 + 1];
      sVal[sv3 + 2] = normals[i3 + 2];
      entry.restNormalsSparseCount = sc + 1;
    }
  }

  /**
   * Recomputes exact area-weighted deformed triangle normals for ONLY the `mutatedCount` vertices
   * recorded in `this.touchedScratch`. Runs strictly in O(k * avgValence), never O(N).
   */
  private recomputeLocalTriangleNormals(
    entry: MeshEntry,
    normals: Float32Array,
    indices: Uint16Array | Uint32Array,
    pos: Float32Array,
    mutatedCount: number,
  ): void {
    if (!entry.adjacencyAttempted) {
      entry.adjacencyAttempted = true;
      entry.adjacency = buildVertexTriangleAdjacency(entry.spatial.vertexCount, indices);
    }
    const adj = entry.adjacency;
    if (!adj) return;

    const triOffsets = adj.triOffsets;
    const triIndices = adj.triIndices;
    const touched = this.touchedScratch;

    for (let idx = 0; idx < mutatedCount; idx++) {
      const v = touched[idx];
      const i3 = v * 3;
      this.backupVertexNormal(entry, normals, v, i3);

      const tStart = triOffsets[v];
      const tEnd = triOffsets[v + 1];
      if (tStart === tEnd) continue;

      let sx = 0;
      let sy = 0;
      let sz = 0;

      for (let k = tStart; k < tEnd; k++) {
        const base = triIndices[k] * 3;
        const a3 = indices[base] * 3;
        const b3 = indices[base + 1] * 3;
        const c3 = indices[base + 2] * 3;

        const ax = pos[a3];
        const ay = pos[a3 + 1];
        const az = pos[a3 + 2];
        const e1x = pos[b3] - ax;
        const e1y = pos[b3 + 1] - ay;
        const e1z = pos[b3 + 2] - az;
        const e2x = pos[c3] - ax;
        const e2y = pos[c3 + 1] - ay;
        const e2z = pos[c3 + 2] - az;

        // Area-weighted face normal cross product (e1 x e2)
        sx += e1y * e2z - e1z * e2y;
        sy += e1z * e2x - e1x * e2z;
        sz += e1x * e2y - e1y * e2x;
      }

      const lenSq = sx * sx + sy * sy + sz * sz;
      if (lenSq > 1e-12) {
        const invLen = 1 / Math.sqrt(lenSq);
        normals[i3] = sx * invLen;
        normals[i3 + 1] = sy * invLen;
        normals[i3 + 2] = sz * invLen;
      }
    }
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
    nx: number,
    nz: number,
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

    // Corner impacts degrade wheel integrity AND structural wheel/axle geometry [FL, FR, RL, RR].
    const wheelReach = Math.max(1.15, radius * 1.3);
    const wheelDamage = this.health.wheelDamage!;
    for (let w = 0; w < 4; w++) {
      const [wx, wy, wz] = this.wheelPositions[w];
      const dist = Math.hypot(ix - wx, iy - wy, iz - wz);
      if (dist < wheelReach) {
        const proximity = 1 - dist / wheelReach;
        const wheelLoss = damageUnit * (0.28 + 0.72 * proximity * proximity);
        const nextIntegrity = clamp(this.health.wheelIntegrity[w] - wheelLoss, 0, 1);
        this.health.wheelIntegrity[w] = nextIntegrity;

        const wd = wheelDamage[w];
        wd.integrity = nextIntegrity;
        const dmg = 1 - nextIntegrity;
        const sideSign = w === 0 || w === 2 ? 1 : -1; // +1 left (FL/RL), -1 right (FR/RR)
        const isFront = w === 0 || w === 1;

        // Camber bend: impacts above hub bend wheel top inward (negative camber); low curb hits tuck bottom inward.
        const camberDir = iy >= wy - 0.05 ? -sideSign : sideSign;
        const camberDelta = wheelLoss * 0.36 * camberDir;
        wd.camberRad = clamp(wd.camberRad + camberDelta, -0.34, 0.34);

        // Toe bend: front/side corner hits bend tie-rods/arms visibly crooked.
        const toeBias = (nx * 0.65 + (isFront ? -nz : nz) * 0.35 * sideSign) || -sideSign;
        const toeSign = toeBias >= 0 ? 1 : -1;
        const toeScale = isFront ? 0.3 : 0.18;
        wd.toeRad = clamp(wd.toeRad + wheelLoss * toeScale * toeSign, -0.28, 0.28);

        // Bent rim wobble amplitude grows smoothly with wheel damage.
        wd.wobbleRad = dmg > 0.04 ? clamp(dmg * 0.22, 0, 0.22) : 0;

        // Normalized suspension strut collapse (0..1, matching @blend-garage/world-racing) once corner takes serious damage (>20% loss).
        wd.collapsed = dmg > 0.2 ? clamp(Math.pow((dmg - 0.2) / 0.8, 1.25), 0, 1) : 0;
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
    detachedParts: DetachedPartEvent[],
    meshUpdates: MeshDamageUpdate[],
  ): DamageStepResult {
    return {
      dirtyPartIds,
      detachedPartIds: Array.from(this.detachedIds),
      detachedImpulses,
      detachedParts,
      meshUpdates,
      health: cloneMechanicalHealth(this.health),
    };
  }
}
