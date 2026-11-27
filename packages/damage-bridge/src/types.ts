import type { Vec3 } from '@blend-garage/vehicle-core';

/**
 * Typed vertex payload passed between Three.js BufferGeometry and the external
 * JS/TS/WASM car damage simulation (Phase 2).
 */
export interface DeformableMeshPayload {
  partId: string;
  /** Flat xyz array of undeformed rest positions (length = vertexCount * 3). */
  restPositions: Float32Array;
  /** Flat xyz array of current deformed positions (mutated or returned by the sim). */
  positions: Float32Array;
  /** Optional vertex normals; locally updated on impact when provided, or recomputed by the renderer if omitted. */
  normals?: Float32Array;
}

export interface DamageInitConfig {
  carId: string;
  massKg: number;
  meshes: DeformableMeshPayload[];
}

export interface ImpactEvent {
  /** Impact point in vehicle-local meters. */
  localPoint: Vec3;
  /** Inward impact direction (normalized) in vehicle-local space. */
  localNormal: Vec3;
  /** Scalar impulse magnitude in N·s. */
  impulse: number;
  /** Relative closing speed in m/s. */
  relativeSpeed: number;
  /** Optional target part hint if known from raycast/collider. */
  partId?: string;
}

export interface MechanicalHealth {
  chassisIntegrity: number; // 0..1
  engineHealth: number; // 0..1
  steeringPull: number; // -1..1
  wheelIntegrity: [number, number, number, number]; // FL, FR, RL, RR (0..1)
  headlightsIntact: boolean;
  taillightsIntact: boolean;
}

/**
 * Launch metadata emitted when a detachable panel (bumper, spoiler, hood, mirror,
 * door, fender) exceeds its structural detachment threshold on an impact.
 */
export interface DetachedPartImpulse {
  partId: string;
  /** Linear launch impulse / velocity delta in vehicle-local space (m/s). */
  impulse: Vec3;
  /** Angular tumble velocity in vehicle-local space (rad/s). */
  angularVelocity: Vec3;
  /** Approximate launch center of the detached part in vehicle-local meters. */
  origin: Vec3;
}

export interface DamageStepResult {
  dirtyPartIds: string[];
  detachedPartIds: string[];
  /** Newly detached parts on this step with suggested debris launch impulses. */
  detachedImpulses?: DetachedPartImpulse[];
  health: MechanicalHealth;
}

export interface DamageBounds {
  min: Vec3;
  max: Vec3;
}

export type DamagePartCategory =
  | 'body'
  | 'bumper'
  | 'hood'
  | 'trunk'
  | 'fender'
  | 'door'
  | 'spoiler'
  | 'mirror'
  | 'exhaust'
  | 'other';

export interface RealDamageSimulatorOptions {
  /** Minimum impulse (N·s) required to trigger plastic deformation. Default: 150. */
  minImpulse?: number;
  /** Minimum closing speed (m/s) required to trigger plastic deformation. Default: 1.0. */
  minRelativeSpeed?: number;
  /**
   * Minimum time (seconds) between throttling repeated lower-energy contacts at the same spot
   * while `step(dt)` is advancing. Default: 0.05.
   */
  cooldownSeconds?: number;
  /** Maximum cumulative vertex displacement from rest position in meters. Default: auto (~0.45 m). */
  maxVertexDisplacement?: number;
  /** Spatial grid cell size in meters for high-poly acceleration. Default: 0.25. */
  cellSize?: number;
  /** Optional explicit rigid cabin safety cell bounds in vehicle-local meters. */
  cabinBox?: DamageBounds;
  /** Optional explicit wheel centers [FL, FR, RL, RR] in vehicle-local meters. */
  wheelPositions?: [Vec3, Vec3, Vec3, Vec3];
  /** Optional energy thresholds (Joules) overriding default detachment thresholds by partId or logical partId. */
  detachablePartThresholds?: Record<string, number>;
  /** Whether to locally perturb `payload.normals` when provided. Default: true. */
  updateNormals?: boolean;
}

export function createHealthyMechanicalHealth(): MechanicalHealth {
  return {
    chassisIntegrity: 1,
    engineHealth: 1,
    steeringPull: 0,
    wheelIntegrity: [1, 1, 1, 1],
    headlightsIntact: true,
    taillightsIntact: true,
  };
}

export function cloneMechanicalHealth(health: MechanicalHealth): MechanicalHealth {
  return {
    chassisIntegrity: health.chassisIntegrity,
    engineHealth: health.engineHealth,
    steeringPull: health.steeringPull,
    wheelIntegrity: [
      health.wheelIntegrity[0],
      health.wheelIntegrity[1],
      health.wheelIntegrity[2],
      health.wheelIntegrity[3],
    ],
    headlightsIntact: health.headlightsIntact,
    taillightsIntact: health.taillightsIntact,
  };
}

/**
 * Adapter boundary for Blend Garage's JS/TS/WASM damage simulation.
 * Implementations can run synchronously on the main thread or proxy to a Web Worker.
 */
export interface DamageSimulator {
  readonly name: string;
  init(config: DamageInitConfig): Promise<void> | void;
  applyImpact(event: ImpactEvent): DamageStepResult;
  step(dtSeconds: number): DamageStepResult;
  reset(): DamageStepResult;
  dispose(): void;
}
