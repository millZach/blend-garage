import type { ImpactEvent, MechanicalHealth } from '@blend-garage/damage-bridge';
import type { CarBuild, Vec3, VehicleManifest } from '@blend-garage/vehicle-core';

/** Quaternion ordered as [x, y, z, w] (matching Three.js and Rapier). */
export type Quat = [number, number, number, number];

export type WheelCorner = 'FL' | 'FR' | 'RL' | 'RR';

export type DrivetrainType = 'rwd' | 'awd' | 'fwd';

export type TransmissionMode = 'auto' | 'manual';

export type WorldSurfaceType = 'asphalt' | 'concrete' | 'gravel' | 'dirt' | 'grass' | 'metal' | 'wood';

/** Normalized road/ground surface category consumed by the procedural audio engine. */
export type AudioSurfaceType = 'asphalt' | 'concrete' | 'gravel' | 'grass';

/** Edge-triggered gear shift event for audio & HUD transients. */
export type ShiftDirection = 'up' | 'down' | null;

export interface VehicleControlInput {
  /** Throttle pedal 0..1. */
  throttle: number;
  /** Brake / reverse pedal 0..1. */
  brake: number;
  /** Steering input -1..+1 (-1 = full left, +1 = full right). */
  steer: number;
  /** Handbrake / drift brake engaged. */
  handbrake: boolean;
  /** Optional sequential gear shift request for this step (-1 down, 0 none, +1 up). */
  shift?: -1 | 0 | 1;
  /** Optional automotive horn active while held. */
  horn?: boolean;
}

/** Audio- & HUD-ready continuous vehicle driving telemetry. */
export interface DriveTelemetry {
  speedKmh: number;
  speedMph: number;
  forwardSpeedMs: number;
  rpm: number;
  idleRpm: number;
  redlineRpm: number;
  gear: number;
  gearLabel: string;
  throttle: number;
  brake: number;
  steer: number;
  handbrake: boolean;
  /** Turbocharger spool estimate in [0, 1]. */
  turboBoost: number;
  /** Peak lateral/longitudinal tire slip ratio in [0, 1] across grounded wheels. */
  slipRatio: number;
  /** Average suspension load/compression in [0, 1] across grounded wheels. */
  wheelLoad: number;
  /** Dominant road/terrain surface under the tires. */
  surface: AudioSurfaceType;
  /** True when all 4 wheels are off the ground. */
  airborne: boolean;
  /** Edge-triggered gear shift direction on the step a shift occurs, else null. */
  shiftEvent: ShiftDirection;
  /** Continuous sliding scrape contact intensity in [0, 1] against walls/guardrails/ground. */
  scrapeIntensity: number;
  /** True while the automotive horn is held. */
  horn: boolean;
}

export interface VehicleTelemetry {
  speedKmh: number;
  rpm: number;
  gear: number;
  position: Vec3;
  headingRad: number;
}

export interface SpawnedWorldVehicle {
  manifest: VehicleManifest;
  build: CarBuild;
  telemetry: VehicleTelemetry;
}

export interface RaceCheckpoint {
  id: string;
  position: Vec3;
  radiusMeters: number;
}

export interface RaceTrackDefinition {
  id: string;
  name: string;
  laps: number;
  spawnPosition: Vec3;
  spawnHeadingRad: number;
  checkpoints: RaceCheckpoint[];
}

// ---------------------------------------------------------------------------
// World Static Colliders
// ---------------------------------------------------------------------------

export interface WorldColliderBase {
  id?: string;
  /** Semantic tag such as 'road', 'terrain', 'barrier', 'wall', 'building', 'ramp', 'pillar', 'boundary'. */
  tag?: string;
  /** Surface material for tire grip & FX. Defaults to 'asphalt'. */
  surface?: WorldSurfaceType;
  /** Static collider friction coefficient (default 0.85). */
  friction?: number;
  /** Static collider restitution / bounce (default 0.1). */
  restitution?: number;
}

export interface BoxColliderDef extends WorldColliderBase {
  type: 'box';
  /** World-space center [x, y, z] in meters. */
  position: Vec3;
  /** Half-extents [hx, hy, hz] in meters. */
  halfExtents: Vec3;
  /** Optional orientation quaternion [x, y, z, w]. Takes precedence over `euler`. */
  rotation?: Quat;
  /** Optional XYZ Euler rotation [rx, ry, rz] in radians (applied in YXZ order, matching Three.js road/ramp placement). */
  euler?: Vec3;
}

export interface CylinderColliderDef extends WorldColliderBase {
  type: 'cylinder';
  /** World-space center [x, y, z] in meters. */
  position: Vec3;
  /** Cylinder radius in meters. */
  radius: number;
  /** Half-height along local Y in meters. */
  halfHeight: number;
  /** Optional orientation quaternion [x, y, z, w]. Takes precedence over `euler`. */
  rotation?: Quat;
  /** Optional Euler rotation [rx, ry, rz] in radians (YXZ order). */
  euler?: Vec3;
}

export interface HeightfieldColliderDef extends WorldColliderBase {
  type: 'heightfield';
  /** World-space center [x, y, z] of the heightfield (default [0, 0, 0]). */
  position?: Vec3;
  /** Number of grid subdivisions along Z (there are nrows + 1 samples along Z). */
  nrows: number;
  /** Number of grid subdivisions along X (there are ncols + 1 samples along X). */
  ncols: number;
  /**
   * Column-major height samples of length (nrows + 1) * (ncols + 1).
   * Rapier 3D convention: `heights[col * (nrows + 1) + row]` where
   * `col` spans X from `-scale[0]/2` (0) to `+scale[0]/2` (ncols), and
   * `row` spans Z from `-scale[2]/2` (0) to `+scale[2]/2` (nrows).
   */
  heights: Float32Array;
  /** Total world dimensions [sizeX, scaleY, sizeZ] in meters. */
  scale: Vec3;
}

export interface TrimeshColliderDef extends WorldColliderBase {
  type: 'trimesh';
  /** Optional world-space translation [x, y, z] (default [0, 0, 0]). */
  position?: Vec3;
  /** Optional orientation quaternion [x, y, z, w]. */
  rotation?: Quat;
  /** Flat xyz vertex positions. */
  vertices: Float32Array;
  /** Triangle index buffer (length = triangleCount * 3). */
  indices: Uint32Array;
}

export type WorldColliderDef =
  | BoxColliderDef
  | CylinderColliderDef
  | HeightfieldColliderDef
  | TrimeshColliderDef;

// ---------------------------------------------------------------------------
// Dynamic Knockable World Props (shared with OpenWorld)
// ---------------------------------------------------------------------------

export type DynamicPropKind = 'barrel' | 'crate' | 'barrier' | 'cone' | 'tire-stack';

export interface DynamicWorldPropDef {
  id: string;
  kind: DynamicPropKind;
  shape: 'box' | 'cylinder';
  /** Half-extents [hx, hy, hz] for box; for cylinder [radius, halfHeight, radius]. */
  halfExtents: [number, number, number];
  position: [number, number, number];
  rotationY?: number;
  mass: number;
  restitution?: number;
  friction?: number;
}

export interface DynamicPropTransform {
  id: string;
  position: [number, number, number];
  quaternion: [number, number, number, number];
  sleeping: boolean;
}

/** Optional per-wheel structural axle/suspension damage (aligned with @blend-garage/damage-bridge). */
export interface WheelStructuralDamage {
  integrity: number;
  camberRad: number;
  toeRad: number;
  wobbleRad: number;
  collapsed: number;
}

/** Extended mechanical health accepting optional structural wheel damage without breaking backwards compatibility. */
export interface VehicleMechanicalHealth extends MechanicalHealth {
  wheelDamage?: [
    WheelStructuralDamage,
    WheelStructuralDamage,
    WheelStructuralDamage,
    WheelStructuralDamage,
  ];
}

// ---------------------------------------------------------------------------
// Vehicle Physics Config & State
// ---------------------------------------------------------------------------

export interface WheelPhysicsConfig {
  corner: WheelCorner;
  /** Nominal rest wheel center in car-local meters (origin on floor under car center, +Z nose, +X left). */
  position: Vec3;
  /** Wheel outer radius in meters. */
  radius: number;
  /** Tire width in meters. */
  width: number;
  steerable: boolean;
  driven: boolean;
}

export interface VehiclePhysicsConfig {
  /** Total vehicle mass in kg (default 1480). */
  massKg: number;
  /** Outer bounding dimensions [width, height, length] in meters. */
  chassisSize: Vec3;
  /** Center of mass in car-local meters (default [0, 0.42, 0.05]). */
  centerOfMassOffset?: Vec3;
  /** Exactly 4 wheels in [FL, FR, RL, RR] order. */
  wheels: [WheelPhysicsConfig, WheelPhysicsConfig, WheelPhysicsConfig, WheelPhysicsConfig];
  /** Drivetrain layout (default 'awd'). */
  drivetrain?: DrivetrainType;
  /** Peak engine power in kW (default 350). */
  maxPowerKw?: number;
  /** Peak engine torque in N·m (default 560). */
  maxTorqueNm?: number;
  /** Redline RPM (default 7600). */
  maxRpm?: number;
  /** Idle RPM (default 900). */
  idleRpm?: number;
  /** Forward gear ratios (1st..Nth). */
  gearRatios?: number[];
  /** Reverse gear ratio (positive magnitude, default 3.1). */
  reverseRatio?: number;
  /** Final drive ratio (default 3.55). */
  finalDrive?: number;
  /** Initial transmission mode (default 'auto'). */
  transmission?: TransmissionMode;
  /** Suspension spring rest length in meters (default 0.30). */
  suspensionRestLength?: number;
  /** Maximum suspension travel from rest length in meters (default 0.16). */
  suspensionTravel?: number;
  /** Suspension spring stiffness (default 44). */
  suspensionStiffness?: number;
  /** Suspension compression damping (default 4.2). */
  suspensionDampingCompression?: number;
  /** Suspension rebound/relaxation damping (default 5.4). */
  suspensionDampingRelaxation?: number;
  /** Max front steer angle in radians at low speed (default 0.58 rad / ~33 deg). */
  maxSteerAngleRad?: number;
  /** Nominal tire friction slip factor (default 2.7). */
  tireGrip?: number;
  /** Lateral tire stiffness multiplier (default 1.35). */
  sideFrictionStiffness?: number;
  /** Max braking force per wheel (default 72). */
  maxBrakeForce?: number;
  /** Optional ride height offset in meters from build stance (default 0). */
  rideHeightOffset?: number;
  /** Initial world spawn position [x, y, z] (default [0, 0.15, 0]). */
  spawnPosition?: Vec3;
  /** Initial heading around +Y in radians; 0 faces +Z (default 0). */
  spawnHeadingRad?: number;
  /** Minimum impact impulse in N·s required to emit a crash ImpactEvent (default 900). */
  impactImpulseThreshold?: number;
  /** Minimum relative speed in m/s required to emit a crash ImpactEvent (default 2.2). */
  impactSpeedThreshold?: number;
}

export interface WheelPhysicsState {
  corner: WheelCorner;
  inContact: boolean;
  /**
   * Vertical offset of the wheel hub from its nominal rest position in meters
   * (+ = compressed up into wheel arch, - = drooped down). Directly maps to `wheel.hub.position.y`.
   */
  suspensionOffset: number;
  /** Current suspension length in meters. */
  suspensionLength: number;
  /** Normalized compression 0 (full droop) .. 1 (full bump). */
  compression: number;
  /** Steering angle around car +Y in radians (+ = left, - = right). Directly maps to `wheel.steer.rotation.y`. */
  steerAngleRad: number;
  /** Cumulative spin angle around local +X in radians (+ = forward roll). Directly maps to `wheel.spin.rotation.x`. */
  spinAngleRad: number;
  /** Wheel angular velocity in rad/s. */
  angularVelocityRad: number;
  /** Estimated tire slip intensity 0..1+ (for skidmarks / smoke / audio). */
  slipRatio: number;
  /** Wheel wobble offset in radians caused by wheel damage (0 when intact). */
  wobbleRad: number;
  /** Bent camber offset in radians caused by structural corner damage (0 when intact). */
  camberDamageRad: number;
  /** Bent toe offset in radians caused by structural corner damage (0 when intact). */
  toeDamageRad: number;
  /** World-space tire contact point if grounded, else null. */
  contactPoint: Vec3 | null;
  /** Ground surface type currently under this wheel. */
  surface: WorldSurfaceType;
}

export interface VehiclePhysicsState {
  /** World-space position of the car's floor-origin frame (maps directly to `VehicleRig.root.position`). */
  position: Vec3;
  /** World-space orientation quaternion [x, y, z, w] (maps directly to `VehicleRig.root.quaternion`). */
  quaternion: Quat;
  /** World-space linear velocity in m/s. */
  linearVelocity: Vec3;
  /** World-space angular velocity in rad/s. */
  angularVelocity: Vec3;
  /** Signed forward speed along car's local +Z axis in m/s. */
  forwardSpeedMs: number;
  /** Unsigned total speed in km/h. */
  speedKmh: number;
  /** Unsigned total speed in mph. */
  speedMph: number;
  /** Yaw heading around +Y in radians (0 = +Z). */
  headingRad: number;
  /** Current engine RPM. */
  rpm: number;
  /** Engine idle RPM. */
  idleRpm: number;
  /** Engine redline RPM (alias of `maxRpm` for audio telemetry). */
  redlineRpm: number;
  /** Engine redline RPM. */
  maxRpm: number;
  /** Current gear: -1 = Reverse, 0 = Neutral, 1..N = Forward. */
  gear: number;
  /** Display gear label ('R', 'N', '1'..'6'). */
  gearLabel: string;
  /** Edge-triggered gear shift direction on the step a shift occurs, else null. */
  shiftEvent: ShiftDirection;
  /** Current transmission mode. */
  transmission: TransmissionMode;
  /** Effective applied throttle (0..1). */
  throttle: number;
  /** Effective applied brake (0..1). */
  brake: number;
  /** Effective applied steering (-1..1). */
  steer: number;
  /** Handbrake state. */
  handbrake: boolean;
  /** Turbocharger boost spool estimate in [0, 1]. */
  turboBoost: number;
  /** Peak lateral/longitudinal tire slip ratio in [0, 1] across grounded wheels. */
  slipRatio: number;
  /** Average suspension load/compression in [0, 1] across grounded wheels. */
  wheelLoad: number;
  /** Dominant road/terrain surface under the tires. */
  surface: AudioSurfaceType;
  /** Continuous sliding wall/guardrail/ground scrape contact intensity in [0, 1]. */
  scrapeIntensity: number;
  /** True while the automotive horn is held. */
  horn: boolean;
  /** True when all 4 wheels are off the ground. */
  airborne: boolean;
  /** Count of wheels currently touching ground (0..4). */
  groundedWheels: number;
  /** Per-wheel states in [FL, FR, RL, RR] order. */
  wheels: [WheelPhysicsState, WheelPhysicsState, WheelPhysicsState, WheelPhysicsState];
}

export interface PhysicsImpactRecord {
  /** Exact `@blend-garage/damage-bridge` ImpactEvent in car-local coordinates. */
  event: ImpactEvent;
  /** World-space contact point [x, y, z] for sparks/audio. */
  worldPoint: Vec3;
  /** World-space unit normal pointing from obstacle into the vehicle. */
  worldNormal: Vec3;
  /** Estimated peak deceleration in G-force for camera shake, rumble, and HUD readout. */
  gForce: number;
  colliderId?: string;
  colliderTag?: string;
  /** True when the impact was against a dynamic knockable world prop. */
  isDynamicProp?: boolean;
  /** Prop kind when `isDynamicProp` is true. */
  dynamicPropKind?: DynamicPropKind;
}

export interface PhysicsStepResult {
  state: VehiclePhysicsState;
  impacts: PhysicsImpactRecord[];
}

export interface PhysicsAdvanceResult {
  /** Latest physics state after the final fixed substep. */
  state: VehiclePhysicsState;
  /** Smoothly interpolated visual pose between previous and current fixed substeps. */
  interpolatedState: VehiclePhysicsState;
  /** Substep interpolation factor in [0, 1]. */
  alpha: number;
  /** Number of fixed substeps executed this frame (bounded to prevent spiral of death). */
  substeps: number;
  /** All crash impact records emitted across substeps this frame. */
  impacts: PhysicsImpactRecord[];
  /** Aggregated shift event across substeps ('up' | 'down' | null). */
  shiftEvent: ShiftDirection;
}

export interface DrivingWorldSimLike {
  step(dtSeconds: number, input: VehicleControlInput): PhysicsStepResult;
  advance(
    frameDtSeconds: number,
    input: VehicleControlInput,
    fixedDt?: number,
    maxSubsteps?: number,
  ): PhysicsAdvanceResult;
  getState(): VehiclePhysicsState;
  getInterpolatedState(alpha: number): VehiclePhysicsState;
  setMechanicalHealth(health: VehicleMechanicalHealth): void;
  setTransmissionMode(mode: TransmissionMode): void;
  resetPose(position: Vec3, headingRad: number): VehiclePhysicsState;
  addColliders(colliders: WorldColliderDef[]): void;
  addDynamicProps(props: readonly DynamicWorldPropDef[]): void;
  resetDynamicProps(): void;
  getDynamicPropTransforms(): readonly DynamicPropTransform[];
  dispose(): void;
}

// ---------------------------------------------------------------------------
// Drive Input Controller (Keyboard + W3C Gamepad)
// ---------------------------------------------------------------------------

export type InputSource = 'keyboard' | 'gamepad';

export interface DriveInputActions {
  repair: boolean;
  reset: boolean;
  cycleCamera: boolean;
  toggleHeadlights: boolean;
  exitDrive: boolean;
  toggleTransmission: boolean;
  /** Edge-triggered one-tap Inspect / Pan Damage camera toggle (Keyboard V, Gamepad L3). */
  toggleInspect: boolean;
}

export interface DriveInputFrame {
  control: VehicleControlInput;
  actions: DriveInputActions;
  /** Right-stick horizontal camera orbit input (-1..+1, deadzoned). */
  cameraOrbitX: number;
  /** Right-stick vertical camera orbit input (-1..+1, deadzoned). */
  cameraOrbitY: number;
  activeSource: InputSource;
  gamepadName: string | null;
  gamepadConnected: boolean;
}

export interface GamepadButtonLike {
  pressed: boolean;
  value: number;
}

export interface GamepadActuatorLike {
  playEffect?: (
    type: 'dual-rumble',
    params?: {
      startDelay?: number;
      duration?: number;
      weakMagnitude?: number;
      strongMagnitude?: number;
    },
  ) => Promise<unknown> | unknown;
}

export interface GamepadLike {
  id: string;
  connected?: boolean;
  axes: readonly number[];
  buttons: readonly GamepadButtonLike[];
  vibrationActuator?: GamepadActuatorLike | null;
}

export interface DriveInputOptions {
  /** Analog stick deadzone 0..0.5 (default 0.12). */
  stickDeadzone?: number;
  /** Non-linear steering exponent (default 1.55). */
  steerExponent?: number;
  /** Analog trigger deadzone 0..0.3 (default 0.05). */
  triggerDeadzone?: number;
  /** Keyboard steering ramp speed in units/sec (default 5.5). */
  keyboardSteerRate?: number;
  /** Keyboard steering recenter speed in units/sec (default 7.5). */
  keyboardSteerReturnRate?: number;
  /** Optional custom gamepad provider for deterministic tests. */
  getGamepads?: () => readonly (GamepadLike | null)[];
}
