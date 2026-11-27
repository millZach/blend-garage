import RAPIER from '@dimforge/rapier3d-compat';
import type { ImpactEvent, MechanicalHealth } from '@blend-garage/damage-bridge';
import type { Vec3 } from '@blend-garage/vehicle-core';
import type {
  AudioSurfaceType,
  DrivingWorldSimLike,
  DynamicPropKind,
  DynamicPropTransform,
  DynamicWorldPropDef,
  PhysicsAdvanceResult,
  PhysicsImpactRecord,
  PhysicsStepResult,
  Quat,
  ShiftDirection,
  TransmissionMode,
  VehicleControlInput,
  VehicleMechanicalHealth,
  VehiclePhysicsConfig,
  VehiclePhysicsState,
  WheelPhysicsConfig,
  WheelPhysicsState,
  WheelStructuralDamage,
  WorldColliderDef,
  WorldSurfaceType,
} from './types.js';

const GRAVITY = 9.81;
const MS_TO_KMH = 3.6;
const MS_TO_MPH = 2.236936292;
const DEFAULT_GEAR_RATIOS = [3.42, 2.24, 1.60, 1.20, 0.94, 0.74];

const SURFACE_GRIP_MULT: Record<WorldSurfaceType, number> = {
  asphalt: 1.0,
  concrete: 0.96,
  metal: 0.80,
  wood: 0.78,
  gravel: 0.74,
  dirt: 0.72,
  grass: 0.62,
};

function toAudioSurface(surface: WorldSurfaceType): AudioSurfaceType {
  switch (surface) {
    case 'grass':
      return 'grass';
    case 'gravel':
    case 'dirt':
      return 'gravel';
    case 'concrete':
    case 'metal':
    case 'wood':
      return 'concrete';
    default:
      return 'asphalt';
  }
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

function lerpVec3(a: Vec3, b: Vec3, t: number): Vec3 {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
}

function slerpQuat(a: Quat, b: Quat, t: number): Quat {
  let bx = b[0];
  let by = b[1];
  let bz = b[2];
  let bw = b[3];
  let dot = a[0] * bx + a[1] * by + a[2] * bz + a[3] * bw;
  if (dot < 0) {
    dot = -dot;
    bx = -bx;
    by = -by;
    bz = -bz;
    bw = -bw;
  }
  let s0: number;
  let s1: number;
  if (dot > 0.9995) {
    s0 = 1 - t;
    s1 = t;
  } else {
    const theta = Math.acos(Math.min(1, dot));
    const invSin = 1 / Math.sin(theta);
    s0 = Math.sin((1 - t) * theta) * invSin;
    s1 = Math.sin(t * theta) * invSin;
  }
  const rx = s0 * a[0] + s1 * bx;
  const ry = s0 * a[1] + s1 * by;
  const rz = s0 * a[2] + s1 * bz;
  const rw = s0 * a[3] + s1 * bw;
  const invLen = 1 / (Math.hypot(rx, ry, rz, rw) || 1);
  return [rx * invLen, ry * invLen, rz * invLen, rw * invLen];
}

const DRIVABLE_TAGS = new Set(['road', 'terrain', 'ramp', 'ground', 'floor', 'plaza', 'apron']);

let rapierInitPromise: Promise<void> | null = null;

/** Initializes the embedded Rapier3D WASM module once (safe to call multiple times). */
export function initPhysicsEngine(): Promise<void> {
  if (!rapierInitPromise) {
    rapierInitPromise = RAPIER.init().then(() => undefined);
  }
  return rapierInitPromise;
}

function clamp(v: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, v));
}

function eulerYXZToQuat(rx: number, ry: number, rz: number): Quat {
  const c1 = Math.cos(rx * 0.5);
  const s1 = Math.sin(rx * 0.5);
  const c2 = Math.cos(ry * 0.5);
  const s2 = Math.sin(ry * 0.5);
  const c3 = Math.cos(rz * 0.5);
  const s3 = Math.sin(rz * 0.5);

  // YXZ intrinsic order (yaw ry, then pitch rx, then roll rz)
  const x = s1 * c2 * c3 + c1 * s2 * s3;
  const y = c1 * s2 * c3 - s1 * c2 * s3;
  const z = c1 * c2 * s3 - s1 * s2 * c3;
  const w = c1 * c2 * c3 + s1 * s2 * s3;
  return [x, y, z, w];
}

function headingToQuat(headingRad: number): Quat {
  return [0, Math.sin(headingRad * 0.5), 0, Math.cos(headingRad * 0.5)];
}

function rotateVecByQuat(v: Vec3, q: Quat): Vec3 {
  const [vx, vy, vz] = v;
  const [qx, qy, qz, qw] = q;
  const tx = 2 * (qy * vz - qz * vy);
  const ty = 2 * (qz * vx - qx * vz);
  const tz = 2 * (qx * vy - qy * vx);
  return [
    vx + qw * tx + (qy * tz - qz * ty),
    vy + qw * ty + (qz * tx - qx * tz),
    vz + qw * tz + (qx * ty - qy * tx),
  ];
}

function rotateVecByInvQuat(v: Vec3, q: Quat): Vec3 {
  return rotateVecByQuat(v, [-q[0], -q[1], -q[2], q[3]]);
}

function normalizeVec3(v: Vec3, fallback: Vec3): Vec3 {
  const len = Math.hypot(v[0], v[1], v[2]);
  if (!Number.isFinite(len) || len < 1e-6) return [fallback[0], fallback[1], fallback[2]];
  return [v[0] / len, v[1] / len, v[2] / len];
}

function headingFromQuat(q: Quat): number {
  const fwd = rotateVecByQuat([0, 0, 1], q);
  return Math.atan2(fwd[0], fwd[2]);
}

function torqueCurveFactor(rpmNorm: number): number {
  // Smooth realistic performance-car torque curve peaking around 50-75% RPM.
  const x = clamp(rpmNorm, 0, 1.05);
  if (x < 0.25) return 0.70 + (x / 0.25) * 0.22;
  if (x < 0.72) return 0.92 + Math.sin(((x - 0.25) / 0.47) * Math.PI * 0.75) * 0.08;
  return Math.max(0.76, 1.0 - ((x - 0.72) / 0.33) * 0.16);
}

function defaultMechanicalHealth(): MechanicalHealth {
  return {
    chassisIntegrity: 1,
    engineHealth: 1,
    steeringPull: 0,
    wheelIntegrity: [1, 1, 1, 1],
    headlightsIntact: true,
    taillightsIntact: true,
  };
}

interface ColliderMeta {
  id?: string;
  tag?: string;
  surface: WorldSurfaceType;
  isDynamicProp?: boolean;
  dynamicPropKind?: DynamicPropKind;
  dynamicPropMass?: number;
  dynamicPropBody?: RAPIER.RigidBody;
}

interface DynamicPropRuntime {
  def: DynamicWorldPropDef;
  body: RAPIER.RigidBody;
  collider: RAPIER.Collider;
  spawnPos: Vec3;
  spawnQuat: Quat;
  syncedSleeping: boolean;
}

function defaultWheelStructuralDamage(): [
  WheelStructuralDamage,
  WheelStructuralDamage,
  WheelStructuralDamage,
  WheelStructuralDamage,
] {
  const clean = (): WheelStructuralDamage => ({
    integrity: 1,
    camberRad: 0,
    toeRad: 0,
    wobbleRad: 0,
    collapsed: 0,
  });
  return [clean(), clean(), clean(), clean()];
}

interface WheelRuntime {
  cfg: WheelPhysicsConfig;
  connectionY: number;
  restLength: number;
  staticSag: number;
  spinAngleRad: number;
  angularVelocityRad: number;
  steerAngleRad: number;
  slipRatio: number;
  wobbleRad: number;
  cachedSurface: WorldSurfaceType;
}

interface WheelPoseSnapshot {
  suspensionOffset: number;
  steerAngleRad: number;
  spinAngleRad: number;
  wobbleRad: number;
}

interface PoseSnapshot {
  position: Vec3;
  quaternion: Quat;
  wheels: [WheelPoseSnapshot, WheelPoseSnapshot, WheelPoseSnapshot, WheelPoseSnapshot];
}

function createPoseSnapshot(pos: Vec3, quat: Quat): PoseSnapshot {
  const mkWheel = (): WheelPoseSnapshot => ({
    suspensionOffset: 0,
    steerAngleRad: 0,
    spinAngleRad: 0,
    wobbleRad: 0,
  });
  return {
    position: [pos[0], pos[1], pos[2]],
    quaternion: [quat[0], quat[1], quat[2], quat[3]],
    wheels: [mkWheel(), mkWheel(), mkWheel(), mkWheel()],
  };
}

function copyPoseSnapshot(src: PoseSnapshot, dst: PoseSnapshot): void {
  dst.position[0] = src.position[0];
  dst.position[1] = src.position[1];
  dst.position[2] = src.position[2];
  dst.quaternion[0] = src.quaternion[0];
  dst.quaternion[1] = src.quaternion[1];
  dst.quaternion[2] = src.quaternion[2];
  dst.quaternion[3] = src.quaternion[3];
  for (let i = 0; i < 4; i++) {
    dst.wheels[i].suspensionOffset = src.wheels[i].suspensionOffset;
    dst.wheels[i].steerAngleRad = src.wheels[i].steerAngleRad;
    dst.wheels[i].spinAngleRad = src.wheels[i].spinAngleRad;
    dst.wheels[i].wobbleRad = src.wheels[i].wobbleRad;
  }
}

/**
 * Pure TypeScript 3D vehicle driving & rigid-body collision simulator powered by Rapier3D.
 *
 * Coordinate frame matches Blend Garage's `VehicleRig`:
 * - Car origin (0, 0, 0) sits on the floor under the center of the car at nominal rest ride height.
 * - +Y up, +Z nose forward, +X car left.
 */
export class DrivingWorldSim implements DrivingWorldSimLike {
  private readonly world: RAPIER.World;
  private readonly eventQueue: RAPIER.EventQueue;
  private readonly chassisBody: RAPIER.RigidBody;
  private readonly chassisCollider: RAPIER.Collider;
  private readonly vehicle: RAPIER.DynamicRayCastVehicleController;
  private readonly colliderMeta = new Map<number, ColliderMeta>();
  private readonly lastImpactTimeByCollider = new Map<number, number>();
  private readonly activeContacts = new Set<number>();
  private readonly contactSnapshots = new Map<number, { localPoint: Vec3; localNormalInward: Vec3 }>();
  private readonly dynamicProps: DynamicPropRuntime[] = [];
  private readonly dynamicPropTransforms: DynamicPropTransform[] = [];
  private readonly wheels: [WheelRuntime, WheelRuntime, WheelRuntime, WheelRuntime];

  private readonly config: Required<
    Pick<
      VehiclePhysicsConfig,
      | 'massKg'
      | 'chassisSize'
      | 'drivetrain'
      | 'maxPowerKw'
      | 'maxTorqueNm'
      | 'maxRpm'
      | 'idleRpm'
      | 'gearRatios'
      | 'reverseRatio'
      | 'finalDrive'
      | 'suspensionRestLength'
      | 'suspensionTravel'
      | 'suspensionStiffness'
      | 'suspensionDampingCompression'
      | 'suspensionDampingRelaxation'
      | 'maxSteerAngleRad'
      | 'tireGrip'
      | 'sideFrictionStiffness'
      | 'maxBrakeForce'
      | 'rideHeightOffset'
      | 'impactImpulseThreshold'
      | 'impactSpeedThreshold'
    >
  >;

  private readonly chassisColliderOffsetY: number;
  private readonly chassisHalfExtents: Vec3;
  private readonly chassisComLocal: Vec3;
  private readonly drivenWheelCount: number;
  private readonly avgWheelRadius: number;
  private readonly prevPose: PoseSnapshot;
  private readonly currPose: PoseSnapshot;

  private transmission: TransmissionMode;
  private gear = 1;
  private rpm: number;
  private shiftCooldown = 0;
  private smoothedSteer = 0;
  private lastThrottle = 0;
  private lastBrake = 0;
  private lastHandbrake = false;
  private lastHorn = false;
  private lastShiftEvent: ShiftDirection = null;
  private turboBoost = 0;
  private scrapeIntensity = 0;
  private advanceAccumulator = 0;
  private simTime = 0;
  private prevGroundedWheels = 4;
  private airborneTime = 0;
  private peakFallSpeed = 0;
  private health: MechanicalHealth = defaultMechanicalHealth();
  private wheelDamage: [
    WheelStructuralDamage,
    WheelStructuralDamage,
    WheelStructuralDamage,
    WheelStructuralDamage,
  ] = defaultWheelStructuralDamage();
  private disposed = false;

  private constructor(
    vehicleConfig: VehiclePhysicsConfig,
    colliders: WorldColliderDef[],
    dynamicProps?: readonly DynamicWorldPropDef[],
  ) {
    this.config = {
      massKg: vehicleConfig.massKg,
      chassisSize: vehicleConfig.chassisSize,
      drivetrain: vehicleConfig.drivetrain ?? 'awd',
      maxPowerKw: vehicleConfig.maxPowerKw ?? 360,
      maxTorqueNm: vehicleConfig.maxTorqueNm ?? 580,
      maxRpm: vehicleConfig.maxRpm ?? 7600,
      idleRpm: vehicleConfig.idleRpm ?? 900,
      gearRatios: vehicleConfig.gearRatios?.length ? vehicleConfig.gearRatios : DEFAULT_GEAR_RATIOS,
      reverseRatio: vehicleConfig.reverseRatio ?? 3.15,
      finalDrive: vehicleConfig.finalDrive ?? 3.55,
      suspensionRestLength: vehicleConfig.suspensionRestLength ?? 0.29,
      suspensionTravel: vehicleConfig.suspensionTravel ?? 0.16,
      suspensionStiffness: vehicleConfig.suspensionStiffness ?? 30,
      suspensionDampingCompression: vehicleConfig.suspensionDampingCompression ?? 4.2,
      suspensionDampingRelaxation: vehicleConfig.suspensionDampingRelaxation ?? 5.2,
      maxSteerAngleRad: vehicleConfig.maxSteerAngleRad ?? 0.58,
      tireGrip: vehicleConfig.tireGrip ?? 2.75,
      sideFrictionStiffness: vehicleConfig.sideFrictionStiffness ?? 1.4,
      maxBrakeForce: vehicleConfig.maxBrakeForce ?? 76,
      rideHeightOffset: vehicleConfig.rideHeightOffset ?? 0,
      impactImpulseThreshold: vehicleConfig.impactImpulseThreshold ?? 900,
      impactSpeedThreshold: vehicleConfig.impactSpeedThreshold ?? 2.2,
    };

    this.transmission = vehicleConfig.transmission ?? 'auto';
    this.rpm = this.config.idleRpm;

    this.world = new RAPIER.World({ x: 0, y: -GRAVITY, z: 0 });
    this.world.timestep = 1 / 60;
    this.world.numSolverIterations = 4;
    this.eventQueue = new RAPIER.EventQueue(true);

    // Static world colliders first so queries and spawn work immediately.
    this.addColliders(colliders);

    // Chassis dimensions & mass properties
    const [width, height, length] = this.config.chassisSize;
    const avgRadius =
      vehicleConfig.wheels.reduce((sum, w) => sum + w.radius, 0) / vehicleConfig.wheels.length;
    const groundClearance = clamp(avgRadius * 0.85 + this.config.rideHeightOffset, 0.24, 0.45);
    const topY = Math.max(groundClearance + 0.55, height * 0.92 + this.config.rideHeightOffset);

    const borderRadius = 0.06;
    const hx = Math.max(0.55, width * 0.47 - borderRadius);
    const hy = Math.max(0.24, (topY - groundClearance) * 0.5 - borderRadius);
    const hz = Math.max(1.25, length * 0.485 - borderRadius);
    this.chassisHalfExtents = [hx + borderRadius, hy + borderRadius, hz + borderRadius];
    this.chassisColliderOffsetY = groundClearance + hy + borderRadius;

    const com: Vec3 = vehicleConfig.centerOfMassOffset ?? [0, clamp(height * 0.31, 0.36, 0.54), 0.04];
    this.chassisComLocal = [com[0], com[1], com[2]];
    const m = this.config.massKg;
    const ix = (1 / 12) * m * (height * height + length * length) * 0.88;
    const iy = (1 / 12) * m * (width * width + length * length) * 0.96;
    const iz = (1 / 12) * m * (width * width + height * height) * 1.18;

    const spawnPos = vehicleConfig.spawnPosition ?? [0, 0.12, 0];
    const spawnQuat = headingToQuat(vehicleConfig.spawnHeadingRad ?? 0);

    const bodyDesc = RAPIER.RigidBodyDesc.dynamic()
      .setTranslation(spawnPos[0], spawnPos[1], spawnPos[2])
      .setRotation({ x: spawnQuat[0], y: spawnQuat[1], z: spawnQuat[2], w: spawnQuat[3] })
      .setCanSleep(false)
      .setCcdEnabled(true)
      .setLinearDamping(0.05)
      .setAngularDamping(0.32);

    this.chassisBody = this.world.createRigidBody(bodyDesc);

    // Low restitution + Min combine rule eliminates "rubber brick" wall bouncing so crashes
    // crunch in and absorb kinetic energy realistically.
    const chassisColliderDesc = RAPIER.ColliderDesc.roundCuboid(hx, hy, hz, borderRadius)
      .setTranslation(0, this.chassisColliderOffsetY, 0)
      .setMassProperties(
        m,
        { x: com[0], y: com[1] - this.chassisColliderOffsetY, z: com[2] },
        { x: ix, y: iy, z: iz },
        { x: 0, y: 0, z: 0, w: 1 },
      )
      .setFriction(0.48)
      .setRestitution(0.06)
      .setRestitutionCombineRule(RAPIER.CoefficientCombineRule.Min)
      .setActiveEvents(
        RAPIER.ActiveEvents.CONTACT_FORCE_EVENTS | RAPIER.ActiveEvents.COLLISION_EVENTS,
      )
      .setContactForceEventThreshold(50);

    this.chassisCollider = this.world.createCollider(chassisColliderDesc, this.chassisBody);
    this.chassisBody.recomputeMassPropertiesFromColliders();

    // Raycast vehicle controller configured for Blend Garage axes (+Y up, +Z forward, -X axle)
    this.vehicle = this.world.createVehicleController(this.chassisBody);
    this.vehicle.indexUpAxis = 1;
    this.vehicle.setIndexForwardAxis = 2;

    // Exact static equilibrium sag in Rapier DynamicRayCastVehicleController:
    // Each wheel generates suspension force ~= stiffness * compression * chassisMass,
    // so 4 equal wheels support gravity when staticSag = g / (4 * stiffness).
    const staticSag = clamp(
      GRAVITY / (4 * this.config.suspensionStiffness),
      0.03,
      this.config.suspensionRestLength * 0.55,
    );

    const runtimes = vehicleConfig.wheels.map((wCfg, i): WheelRuntime => {
      const restLength = this.config.suspensionRestLength;
      // Place chassis connection point so at static equilibrium (suspLen = restLength - staticSag),
      // wheel bottom touches y = 0 when chassisBody.y = 0!
      const connectionY = wCfg.radius + (restLength - staticSag);

      this.vehicle.addWheel(
        { x: wCfg.position[0], y: connectionY, z: wCfg.position[2] },
        { x: 0, y: -1, z: 0 },
        { x: -1, y: 0, z: 0 },
        restLength,
        wCfg.radius,
      );

      this.vehicle.setWheelSuspensionStiffness(i, this.config.suspensionStiffness);
      this.vehicle.setWheelSuspensionCompression(i, this.config.suspensionDampingCompression);
      this.vehicle.setWheelSuspensionRelaxation(i, this.config.suspensionDampingRelaxation);
      this.vehicle.setWheelMaxSuspensionTravel(i, this.config.suspensionTravel);
      this.vehicle.setWheelMaxSuspensionForce(i, this.config.massKg * GRAVITY * 2.4);
      this.vehicle.setWheelFrictionSlip(i, this.config.tireGrip);
      this.vehicle.setWheelSideFrictionStiffness(i, this.config.sideFrictionStiffness);

      return {
        cfg: wCfg,
        connectionY,
        restLength,
        staticSag,
        spinAngleRad: 0,
        angularVelocityRad: 0,
        steerAngleRad: 0,
        slipRatio: 0,
        wobbleRad: 0,
        cachedSurface: 'asphalt',
      };
    });

    this.wheels = [runtimes[0], runtimes[1], runtimes[2], runtimes[3]];
    this.drivenWheelCount = this.wheels.filter((w) => w.cfg.driven).length || 2;
    this.avgWheelRadius =
      this.wheels.reduce((sum, w) => sum + w.cfg.radius, 0) / this.wheels.length;
    this.prevPose = createPoseSnapshot(spawnPos, spawnQuat);
    this.currPose = createPoseSnapshot(spawnPos, spawnQuat);

    if (dynamicProps && dynamicProps.length > 0) {
      this.addDynamicProps(dynamicProps);
    }

    this.world.propagateModifiedBodyPositionsToColliders();
    this.world.updateSceneQueries();
    this.captureCurrentPose();
    copyPoseSnapshot(this.currPose, this.prevPose);
  }

  /** Creates a new physics world with initialized Rapier3D WASM, vehicle controller, static colliders, and optional dynamic props. */
  static async create(
    vehicle: VehiclePhysicsConfig,
    colliders: WorldColliderDef[],
    dynamicProps?: readonly DynamicWorldPropDef[],
  ): Promise<DrivingWorldSim> {
    await initPhysicsEngine();
    return new DrivingWorldSim(vehicle, colliders, dynamicProps);
  }

  addColliders(colliders: WorldColliderDef[]): void {
    this.assertNotDisposed();
    for (const def of colliders) {
      const desc = this.buildColliderDesc(def);
      if (!desc) continue;
      desc.setFriction(def.friction ?? 0.85);
      desc.setRestitution(def.restitution ?? 0.08);
      const collider = this.world.createCollider(desc);
      this.colliderMeta.set(collider.handle, {
        id: def.id,
        tag: def.tag,
        surface: def.surface ?? 'asphalt',
      });
    }
    this.world.updateSceneQueries();
  }

  /**
   * Spawns knockable dynamic rigid-body props (barrels, crates, barriers, cones, tire stacks)
   * initially asleep for near-zero idle CPU cost; they wake and tumble automatically on impact.
   */
  addDynamicProps(props: readonly DynamicWorldPropDef[]): void {
    this.assertNotDisposed();
    for (const def of props) {
      const q = headingToQuat(def.rotationY ?? 0);
      const bodyDesc = RAPIER.RigidBodyDesc.dynamic()
        .setTranslation(def.position[0], def.position[1], def.position[2])
        .setRotation({ x: q[0], y: q[1], z: q[2], w: q[3] })
        .setCanSleep(true)
        .setSleeping(true)
        .setLinearDamping(0.32)
        .setAngularDamping(0.42);
      const body = this.world.createRigidBody(bodyDesc);

      const colliderDesc =
        def.shape === 'cylinder'
          ? RAPIER.ColliderDesc.cylinder(
              Math.max(0.05, def.halfExtents[1]),
              Math.max(0.05, def.halfExtents[0]),
            )
          : RAPIER.ColliderDesc.cuboid(
              Math.max(0.05, def.halfExtents[0]),
              Math.max(0.05, def.halfExtents[1]),
              Math.max(0.05, def.halfExtents[2]),
            );

      colliderDesc
        .setMass(Math.max(1, def.mass))
        .setFriction(def.friction ?? 0.62)
        .setRestitution(def.restitution ?? 0.22);

      const collider = this.world.createCollider(colliderDesc, body);
      const surface: WorldSurfaceType =
        def.kind === 'crate'
          ? 'wood'
          : def.kind === 'barrier'
            ? 'concrete'
            : def.kind === 'barrel'
              ? 'metal'
              : 'asphalt';

      this.colliderMeta.set(collider.handle, {
        id: def.id,
        tag: `prop:${def.kind}`,
        surface,
        isDynamicProp: true,
        dynamicPropKind: def.kind,
        dynamicPropMass: Math.max(1, def.mass),
        dynamicPropBody: body,
      });

      const spawnPos: Vec3 = [def.position[0], def.position[1], def.position[2]];
      const spawnQuat: Quat = [q[0], q[1], q[2], q[3]];
      this.dynamicProps.push({
        def,
        body,
        collider,
        spawnPos,
        spawnQuat,
        syncedSleeping: true,
      });
      this.dynamicPropTransforms.push({
        id: def.id,
        position: [spawnPos[0], spawnPos[1], spawnPos[2]],
        quaternion: [spawnQuat[0], spawnQuat[1], spawnQuat[2], spawnQuat[3]],
        sleeping: true,
      });
    }
    this.world.updateSceneQueries();
  }

  /** Restores every dynamic prop to its original resting spawn pose and puts it back to sleep. */
  resetDynamicProps(): void {
    this.assertNotDisposed();
    for (let i = 0; i < this.dynamicProps.length; i++) {
      const prop = this.dynamicProps[i];
      prop.body.setTranslation(
        { x: prop.spawnPos[0], y: prop.spawnPos[1], z: prop.spawnPos[2] },
        false,
      );
      prop.body.setRotation(
        { x: prop.spawnQuat[0], y: prop.spawnQuat[1], z: prop.spawnQuat[2], w: prop.spawnQuat[3] },
        false,
      );
      prop.body.setLinvel({ x: 0, y: 0, z: 0 }, false);
      prop.body.setAngvel({ x: 0, y: 0, z: 0 }, false);
      prop.body.resetForces(false);
      prop.body.resetTorques(false);
      prop.body.sleep();
      prop.syncedSleeping = true;

      const out = this.dynamicPropTransforms[i];
      out.position[0] = prop.spawnPos[0];
      out.position[1] = prop.spawnPos[1];
      out.position[2] = prop.spawnPos[2];
      out.quaternion[0] = prop.spawnQuat[0];
      out.quaternion[1] = prop.spawnQuat[1];
      out.quaternion[2] = prop.spawnQuat[2];
      out.quaternion[3] = prop.spawnQuat[3];
      out.sleeping = true;
    }
    this.world.propagateModifiedBodyPositionsToColliders();
    this.world.updateSceneQueries();
  }

  /**
   * Returns live world-space transforms of all dynamic knockable props in a zero-allocation
   * reusable buffer (safe to pass directly to `OpenWorld.syncDynamicProps()`).
   */
  getDynamicPropTransforms(): readonly DynamicPropTransform[] {
    return this.dynamicPropTransforms;
  }

  setMechanicalHealth(health: VehicleMechanicalHealth): void {
    this.health = {
      chassisIntegrity: clamp(health.chassisIntegrity, 0, 1),
      engineHealth: clamp(health.engineHealth, 0, 1),
      steeringPull: clamp(health.steeringPull, -1, 1),
      wheelIntegrity: [
        clamp(health.wheelIntegrity[0], 0, 1),
        clamp(health.wheelIntegrity[1], 0, 1),
        clamp(health.wheelIntegrity[2], 0, 1),
        clamp(health.wheelIntegrity[3], 0, 1),
      ],
      headlightsIntact: health.headlightsIntact,
      taillightsIntact: health.taillightsIntact,
    };

    const incoming = health.wheelDamage;
    for (let i = 0; i < 4; i++) {
      const wd = incoming?.[i];
      const integrity = wd ? clamp(wd.integrity, 0, 1) : this.health.wheelIntegrity[i];
      const collapsed = wd ? clamp(wd.collapsed, 0, 1) : clamp((0.6 - integrity) / 0.6, 0, 1) * 0.65;
      this.wheelDamage[i] = {
        integrity,
        camberRad: wd ? clamp(wd.camberRad, -0.45, 0.45) : 0,
        toeRad: wd ? clamp(wd.toeRad, -0.35, 0.35) : 0,
        wobbleRad: wd ? clamp(wd.wobbleRad, 0, 0.35) : (integrity < 0.98 ? (1 - integrity) * 0.14 : 0),
        collapsed,
      };

      // Collapse damaged corner suspension & soften spring so smashed corners visibly droop and sag.
      const w = this.wheels[i];
      const effectiveRest = w.restLength * (1 - collapsed * 0.42);
      const effectiveStiff = this.config.suspensionStiffness * (1 - collapsed * 0.35);
      this.vehicle.setWheelSuspensionRestLength(i, effectiveRest);
      this.vehicle.setWheelSuspensionStiffness(i, effectiveStiff);
    }
  }

  setTransmissionMode(mode: TransmissionMode): void {
    this.transmission = mode;
    if (mode === 'auto' && this.gear === 0) {
      this.gear = 1;
    }
  }

  resetPose(position: Vec3, headingRad: number): VehiclePhysicsState {
    this.assertNotDisposed();
    const q = headingToQuat(headingRad);
    this.chassisBody.setTranslation({ x: position[0], y: position[1], z: position[2] }, true);
    this.chassisBody.setRotation({ x: q[0], y: q[1], z: q[2], w: q[3] }, true);
    this.chassisBody.setLinvel({ x: 0, y: 0, z: 0 }, true);
    this.chassisBody.setAngvel({ x: 0, y: 0, z: 0 }, true);
    this.chassisBody.resetForces(true);
    this.chassisBody.resetTorques(true);

    this.gear = 1;
    this.rpm = this.config.idleRpm;
    this.shiftCooldown = 0;
    this.smoothedSteer = 0;
    this.lastThrottle = 0;
    this.lastBrake = 0;
    this.lastHandbrake = false;
    this.lastHorn = false;
    this.lastShiftEvent = null;
    this.turboBoost = 0;
    this.scrapeIntensity = 0;
    this.advanceAccumulator = 0;
    this.airborneTime = 0;
    this.peakFallSpeed = 0;
    this.prevGroundedWheels = 4;
    this.lastImpactTimeByCollider.clear();
    this.activeContacts.clear();
    this.contactSnapshots.clear();

    for (let i = 0; i < 4; i++) {
      this.vehicle.setWheelEngineForce(i, 0);
      this.vehicle.setWheelBrake(i, 0);
      this.vehicle.setWheelSteering(i, 0);
      this.wheels[i].angularVelocityRad = 0;
      this.wheels[i].steerAngleRad = 0;
      this.wheels[i].slipRatio = 0;
      this.wheels[i].wobbleRad = 0;
    }

    this.world.propagateModifiedBodyPositionsToColliders();
    this.world.updateSceneQueries();
    this.vehicle.updateVehicle(1 / 60);
    this.captureCurrentPose();
    copyPoseSnapshot(this.currPose, this.prevPose);
    return this.getState();
  }

  /**
   * Advances physics using an internal bounded fixed-timestep accumulator (`fixedDt = 1/60s`,
   * `maxSubsteps = 3`, clamped `frameDt <= 0.05s`) and returns both the latest simulation state
   * and a smoothly interpolated visual state (`interpolatedState`) for jitter-free rendering at
   * any display refresh rate (60 / 90 / 120 / 144 Hz or variable FPS).
   */
  advance(
    frameDtSeconds: number,
    input: VehicleControlInput,
    fixedDt = 1 / 60,
    maxSubsteps = 3,
  ): PhysicsAdvanceResult {
    this.assertNotDisposed();
    const stepDt = clamp(fixedDt, 1 / 240, 1 / 30);
    const boundedMax = Math.max(1, Math.min(6, Math.round(maxSubsteps)));
    const clampedFrameDt = clamp(Number.isFinite(frameDtSeconds) ? frameDtSeconds : 0, 0, 0.05);

    this.advanceAccumulator = Math.min(this.advanceAccumulator + clampedFrameDt, stepDt * boundedMax);

    let substeps = 0;
    let shiftPending = input.shift ?? 0;
    let shiftEvent: ShiftDirection = null;
    const impacts: PhysicsImpactRecord[] = [];
    let state: VehiclePhysicsState | null = null;

    while (this.advanceAccumulator >= stepDt && substeps < boundedMax) {
      const stepInput: VehicleControlInput =
        shiftPending !== 0
          ? { ...input, shift: shiftPending }
          : { ...input, shift: 0 };
      shiftPending = 0;

      const res = this.step(stepDt, stepInput);
      state = res.state;
      if (res.state.shiftEvent) shiftEvent = res.state.shiftEvent;
      for (let i = 0; i < res.impacts.length; i++) {
        impacts.push(res.impacts[i]);
      }

      this.advanceAccumulator -= stepDt;
      substeps += 1;
    }

    if (!state) {
      this.lastHorn = Boolean(input.horn);
      this.lastShiftEvent = null;
      state = this.getState();
    }

    const alpha = clamp(this.advanceAccumulator / stepDt, 0, 1);
    const interpolatedState = this.getInterpolatedState(alpha);
    interpolatedState.shiftEvent = shiftEvent;

    return {
      state,
      interpolatedState,
      alpha,
      substeps,
      impacts,
      shiftEvent,
    };
  }

  step(dtSeconds: number, input: VehicleControlInput): PhysicsStepResult {
    this.assertNotDisposed();
    const dt = clamp(dtSeconds, 1 / 240, 1 / 20);
    this.simTime += dt;
    this.shiftCooldown = Math.max(0, this.shiftCooldown - dt);

    // Snapshot previous pose before advancing Rapier so visual interpolation is exact.
    copyPoseSnapshot(this.currPose, this.prevPose);

    const throttle = clamp(input.throttle, 0, 1);
    const brake = clamp(input.brake, 0, 1);
    const steerInput = clamp(input.steer, -1, 1);
    const handbrake = Boolean(input.handbrake);
    const shiftReq = input.shift ?? 0;

    this.lastThrottle = throttle;
    this.lastBrake = brake;
    this.lastHandbrake = handbrake;
    this.lastHorn = Boolean(input.horn);

    // Pre-step kinematics for accurate drivetrain, aero, and crash relative speed
    const preVel = this.chassisBody.linvel();
    const preVelVec: Vec3 = [preVel.x, preVel.y, preVel.z];
    const preRot = this.chassisBody.rotation();
    const preQuat: Quat = [preRot.x, preRot.y, preRot.z, preRot.w];
    const localVel = rotateVecByInvQuat(preVelVec, preQuat);
    const forwardSpeedMs = localVel[2];
    const lateralSpeedMs = localVel[0];
    const absSpeedMs = Math.hypot(preVel.x, preVel.y, preVel.z);

    // 1. Snappy speed-sensitive steering + mechanical steering pull
    // High actuator rate prevents double-smoothing lag on top of keyboard ramp while keeping gamepad smooth.
    const steerRate = Math.abs(steerInput) > Math.abs(this.smoothedSteer) ? 16.0 : 20.0;
    const steerDelta = steerInput - this.smoothedSteer;
    const maxStep = steerRate * dt;
    this.smoothedSteer += clamp(steerDelta, -maxStep, maxStep);

    const speedSteerScale = clamp(1 / (1 + (absSpeedMs / 25) * (absSpeedMs / 25)), 0.22, 1.0);
    // In Blend Garage (+Z forward, +X left): positive wheel steering around +Y turns LEFT.
    // Input steer: -1 = left, +1 = right → negate input!
    // Mechanical steeringPull (matching @blend-garage/damage-bridge): positive pulls LEFT (+X).
    const pullAngle = this.health.steeringPull * 0.16;
    const targetSteerRad = clamp(
      -this.smoothedSteer * this.config.maxSteerAngleRad * speedSteerScale + pullAngle,
      -this.config.maxSteerAngleRad,
      this.config.maxSteerAngleRad,
    );

    // 2. Gearbox, RPM & Turbo boost spool
    const { driveForceTotal, serviceBrakeForce } = this.updatePowertrain(
      dt,
      throttle,
      brake,
      handbrake,
      shiftReq,
      forwardSpeedMs,
    );

    // 3. Apply per-wheel steering, drive force, braking, surface grip, and damage penalties
    const drivenWheels = this.drivenWheelCount;
    const awdFrontShare = this.config.drivetrain === 'awd' ? 0.36 : 0;
    const awdRearShare = this.config.drivetrain === 'awd' ? 0.64 : 0;

    for (let i = 0; i < 4; i++) {
      const w = this.wheels[i];
      const isFront = w.cfg.steerable;
      const wheelHealth = this.health.wheelIntegrity[i];
      const wd = this.wheelDamage[i];
      const groundCollider = this.vehicle.wheelGroundObject(i);
      const surface = (groundCollider ? this.colliderMeta.get(groundCollider.handle)?.surface : undefined) ?? 'asphalt';
      w.cachedSurface = surface;
      const surfaceMult = SURFACE_GRIP_MULT[surface];

      // Steering (Ackermann-style slight inner-wheel bias on front axle + bent toe damage)
      let wheelSteer = 0;
      if (isFront) {
        const isLeft = w.cfg.corner === 'FL';
        const innerBias = (targetSteerRad > 0 && isLeft) || (targetSteerRad < 0 && !isLeft) ? 1.06 : 0.95;
        wheelSteer = targetSteerRad * innerBias + wd.toeRad * 0.45;
      }
      w.steerAngleRad = wheelSteer;
      this.vehicle.setWheelSteering(i, wheelSteer);

      // Drive force distribution
      let wheelDrive = 0;
      if (w.cfg.driven && !(handbrake && !isFront)) {
        if (this.config.drivetrain === 'awd') {
          wheelDrive = driveForceTotal * (isFront ? awdFrontShare * 0.5 : awdRearShare * 0.5);
        } else {
          wheelDrive = driveForceTotal / drivenWheels;
        }
      }
      this.vehicle.setWheelEngineForce(i, wheelDrive);

      // Braking + handbrake + damaged wheel/collapsed corner scrub drag
      const frontBrakeBias = isFront ? 1.15 : 0.85;
      const handbrakeForce = handbrake && !isFront ? this.config.maxBrakeForce * 1.45 : 0;
      const damageDrag =
        (wheelHealth < 0.75 ? (0.75 - wheelHealth) * 26 : 0)
        + wd.collapsed * 22
        + Math.abs(wd.toeRad) * 18;
      const engineBraking =
        throttle < 0.04 && brake < 0.04 && Math.abs(forwardSpeedMs) > 0.6 ? 2.6 : 0;
      const totalBrake = Math.max(serviceBrakeForce * frontBrakeBias, handbrakeForce) + damageDrag + engineBraking;
      this.vehicle.setWheelBrake(i, totalBrake);

      // Tire grip & handbrake drift modulation
      const damageGrip = 0.52 + 0.48 * wheelHealth * (1 - wd.collapsed * 0.25);
      const driftFrictionMult = handbrake && !isFront ? 0.42 : 1.0;
      const driftSideMult = handbrake && !isFront ? 0.30 : 1.0;
      this.vehicle.setWheelFrictionSlip(
        i,
        this.config.tireGrip * surfaceMult * damageGrip * driftFrictionMult,
      );
      this.vehicle.setWheelSideFrictionStiffness(
        i,
        this.config.sideFrictionStiffness * surfaceMult * damageGrip * driftSideMult,
      );
    }

    // 4. Aerodynamic drag, downforce, and anti-roll stabilizer bars
    this.chassisBody.resetForces(true);
    this.chassisBody.resetTorques(true);
    this.applyAeroAndStabilizers(preVelVec, preQuat, forwardSpeedMs);

    // 5. Step Rapier vehicle controller + rigid-body world
    this.world.timestep = dt;
    this.vehicle.updateVehicle(dt);
    this.world.step(this.eventQueue);

    // 6. Update visual wheel spin, slip ratio, and damage wobble
    this.updateWheelKinematics(dt, forwardSpeedMs, lateralSpeedMs, throttle, brake, handbrake);

    // 7. Drain rigid-body collision/contact-force events into exact DamageBridge ImpactEvents
    //    plus visceral plastic energy absorption, off-center crash torque, and hard-landing impacts.
    const impacts = this.collectImpactEvents(dt, preVelVec);
    this.detectHardLanding(dt, impacts);

    // 8. Sync awake dynamic prop transforms (zero-allocation), scrape telemetry, & visual pose
    this.syncDynamicPropTransforms();
    this.updateScrapeIntensity(dt, absSpeedMs);
    this.captureCurrentPose();

    return {
      state: this.getState(),
      impacts,
    };
  }

  getState(): VehiclePhysicsState {
    return this.buildState(1);
  }

  /**
   * Returns a smoothly interpolated `VehiclePhysicsState` between the previous fixed substep
   * (`alpha = 0`) and the latest fixed substep (`alpha = 1`), eliminating visual stutter when
   * rendering FPS differs from the fixed physics tick rate.
   */
  getInterpolatedState(alpha: number): VehiclePhysicsState {
    return this.buildState(clamp(alpha, 0, 1));
  }

  private syncDynamicPropTransforms(): void {
    const count = this.dynamicProps.length;
    if (count === 0) return;
    for (let i = 0; i < count; i++) {
      const prop = this.dynamicProps[i];
      const sleeping = prop.body.isSleeping();
      if (sleeping && prop.syncedSleeping) continue;
      const t = prop.body.translation();
      const r = prop.body.rotation();
      const out = this.dynamicPropTransforms[i];
      out.position[0] = t.x;
      out.position[1] = t.y;
      out.position[2] = t.z;
      out.quaternion[0] = r.x;
      out.quaternion[1] = r.y;
      out.quaternion[2] = r.z;
      out.quaternion[3] = r.w;
      out.sleeping = sleeping;
      prop.syncedSleeping = sleeping;
    }
  }

  private detectHardLanding(dt: number, impacts: PhysicsImpactRecord[]): void {
    let grounded = 0;
    for (let i = 0; i < 4; i++) {
      if (this.vehicle.wheelIsInContact(i)) grounded += 1;
    }

    if (grounded === 0) {
      this.airborneTime += dt;
      const vy = this.chassisBody.linvel().y;
      if (-vy > this.peakFallSpeed) this.peakFallSpeed = -vy;
    } else {
      if (this.prevGroundedWheels === 0 && this.airborneTime > 0.28 && this.peakFallSpeed > 6.5) {
        const fallSpeed = this.peakFallSpeed;
        const impulse = this.config.massKg * fallSpeed * 0.62;
        const gForce = clamp(impulse / (this.config.massKg * GRAVITY * 0.04), 1.5, 45);
        const bodyPos = this.chassisBody.translation();
        const bodyRot = this.chassisBody.rotation();
        const bodyQuat: Quat = [bodyRot.x, bodyRot.y, bodyRot.z, bodyRot.w];
        const localPoint: Vec3 = [0, 0.24, 0.25];
        const localNormal: Vec3 = [0, 1, 0];
        const rotPt = rotateVecByQuat(localPoint, bodyQuat);
        const worldNormal = normalizeVec3(rotateVecByQuat(localNormal, bodyQuat), [0, 1, 0]);

        impacts.push({
          event: {
            localPoint,
            localNormal,
            impulse,
            relativeSpeed: fallSpeed,
          },
          worldPoint: [bodyPos.x + rotPt[0], bodyPos.y + rotPt[1], bodyPos.z + rotPt[2]],
          worldNormal,
          gForce,
          colliderId: 'hard-landing',
          colliderTag: 'landing',
        });
      }
      this.airborneTime = 0;
      this.peakFallSpeed = 0;
    }

    this.prevGroundedWheels = grounded;
  }

  private captureCurrentPose(): void {
    const t = this.chassisBody.translation();
    const r = this.chassisBody.rotation();
    this.currPose.position[0] = t.x;
    this.currPose.position[1] = t.y;
    this.currPose.position[2] = t.z;
    this.currPose.quaternion[0] = r.x;
    this.currPose.quaternion[1] = r.y;
    this.currPose.quaternion[2] = r.z;
    this.currPose.quaternion[3] = r.w;

    for (let i = 0; i < 4; i++) {
      const w = this.wheels[i];
      const inContact = this.vehicle.wheelIsInContact(i);
      const suspLen = inContact
        ? (this.vehicle.wheelSuspensionLength(i) ?? w.restLength)
        : w.restLength;
      const wp = this.currPose.wheels[i];
      wp.suspensionOffset = (w.connectionY - suspLen) - w.cfg.radius;
      wp.steerAngleRad = w.steerAngleRad;
      wp.spinAngleRad = w.spinAngleRad;
      wp.wobbleRad = w.wobbleRad;
    }
  }

  private updateScrapeIntensity(dt: number, speedMs: number): void {
    let targetScrape = 0;
    if (this.activeContacts.size > 0 && speedMs > 1.0) {
      let hasObstacleContact = false;
      let hasGroundContact = false;
      for (const handle of this.activeContacts) {
        const meta = this.colliderMeta.get(handle);
        if (meta?.tag && DRIVABLE_TAGS.has(meta.tag)) {
          hasGroundContact = true;
        } else {
          hasObstacleContact = true;
        }
      }
      if (hasObstacleContact) {
        targetScrape = clamp((speedMs - 0.8) / 14, 0.2, 1.0);
      } else if (hasGroundContact && speedMs > 3.0) {
        // Underbody/roof scraping asphalt at speed
        targetScrape = clamp((speedMs - 2.5) / 18, 0.15, 0.85);
      }
    }

    const rate = targetScrape > this.scrapeIntensity ? 18 : 10;
    const blend = 1 - Math.exp(-dt * rate);
    this.scrapeIntensity += (targetScrape - this.scrapeIntensity) * blend;
    if (this.scrapeIntensity < 0.005) this.scrapeIntensity = 0;
  }

  private buildState(alpha: number): VehiclePhysicsState {
    this.assertNotDisposed();
    const lv = this.chassisBody.linvel();
    const av = this.chassisBody.angvel();

    const pos: Vec3 =
      alpha >= 1
        ? [this.currPose.position[0], this.currPose.position[1], this.currPose.position[2]]
        : alpha <= 0
          ? [this.prevPose.position[0], this.prevPose.position[1], this.prevPose.position[2]]
          : lerpVec3(this.prevPose.position, this.currPose.position, alpha);

    const quat: Quat =
      alpha >= 1
        ? [
            this.currPose.quaternion[0],
            this.currPose.quaternion[1],
            this.currPose.quaternion[2],
            this.currPose.quaternion[3],
          ]
        : alpha <= 0
          ? [
              this.prevPose.quaternion[0],
              this.prevPose.quaternion[1],
              this.prevPose.quaternion[2],
              this.prevPose.quaternion[3],
            ]
          : slerpQuat(this.prevPose.quaternion, this.currPose.quaternion, alpha);

    const linVel: Vec3 = [lv.x, lv.y, lv.z];
    const angVel: Vec3 = [av.x, av.y, av.z];
    const localVel = rotateVecByInvQuat(linVel, quat);
    const forwardSpeedMs = localVel[2];
    const totalSpeedMs = Math.hypot(lv.x, lv.y, lv.z);

    let groundedWheels = 0;
    let maxSlip = 0;
    let compressionSum = 0;
    let dominantSurface: AudioSurfaceType = 'asphalt';
    let surfaceAssigned = false;

    const wheelStates: WheelPhysicsState[] = new Array(4);
    for (let i = 0; i < 4; i++) {
      const w = this.wheels[i];
      const inContact = this.vehicle.wheelIsInContact(i);
      const suspLen = inContact
        ? (this.vehicle.wheelSuspensionLength(i) ?? w.restLength)
        : w.restLength;
      const minLen = Math.max(0.02, w.restLength - this.config.suspensionTravel);
      const compression = clamp((w.restLength - suspLen) / Math.max(0.01, w.restLength - minLen), 0, 1);

      const cp = inContact ? this.vehicle.wheelContactPoint(i) : null;
      const surface = inContact ? w.cachedSurface : 'asphalt';

      if (inContact) {
        groundedWheels += 1;
        compressionSum += compression;
        if (w.slipRatio > maxSlip) maxSlip = w.slipRatio;
        const audioSurf = toAudioSurface(surface);
        // Prefer off-road/rough surface if any grounded wheel hits gravel/grass, else first grounded surface
        if (!surfaceAssigned || audioSurf === 'gravel' || audioSurf === 'grass') {
          dominantSurface = audioSurf;
          surfaceAssigned = true;
        }
      }

      const prevW = this.prevPose.wheels[i];
      const currW = this.currPose.wheels[i];
      const suspensionOffset =
        alpha >= 1
          ? currW.suspensionOffset
          : alpha <= 0
            ? prevW.suspensionOffset
            : lerp(prevW.suspensionOffset, currW.suspensionOffset, alpha);
      const steerAngleRad =
        alpha >= 1
          ? currW.steerAngleRad
          : alpha <= 0
            ? prevW.steerAngleRad
            : lerp(prevW.steerAngleRad, currW.steerAngleRad, alpha);
      const spinAngleRad =
        alpha >= 1
          ? currW.spinAngleRad
          : alpha <= 0
            ? prevW.spinAngleRad
            : lerp(prevW.spinAngleRad, currW.spinAngleRad, alpha);
      const wobbleRad =
        alpha >= 1
          ? currW.wobbleRad
          : alpha <= 0
            ? prevW.wobbleRad
            : lerp(prevW.wobbleRad, currW.wobbleRad, alpha);

      wheelStates[i] = {
        corner: w.cfg.corner,
        inContact,
        suspensionOffset,
        suspensionLength: suspLen,
        compression,
        steerAngleRad,
        spinAngleRad,
        angularVelocityRad: w.angularVelocityRad,
        slipRatio: w.slipRatio,
        wobbleRad,
        camberDamageRad: this.wheelDamage[i].camberRad,
        toeDamageRad: this.wheelDamage[i].toeRad,
        contactPoint: cp ? [cp.x, cp.y, cp.z] : null,
        surface,
      };
    }

    return {
      position: pos,
      quaternion: quat,
      linearVelocity: linVel,
      angularVelocity: angVel,
      forwardSpeedMs,
      speedKmh: totalSpeedMs * MS_TO_KMH,
      speedMph: totalSpeedMs * MS_TO_MPH,
      headingRad: headingFromQuat(quat),
      rpm: Math.round(this.rpm),
      idleRpm: this.config.idleRpm,
      redlineRpm: this.config.maxRpm,
      maxRpm: this.config.maxRpm,
      gear: this.gear,
      gearLabel: this.gear === -1 ? 'R' : this.gear === 0 ? 'N' : String(this.gear),
      shiftEvent: this.lastShiftEvent,
      transmission: this.transmission,
      throttle: this.lastThrottle,
      brake: this.lastBrake,
      steer: this.smoothedSteer,
      handbrake: this.lastHandbrake,
      turboBoost: this.turboBoost,
      slipRatio: groundedWheels > 0 ? clamp(maxSlip, 0, 1) : 0,
      wheelLoad: groundedWheels > 0 ? clamp(compressionSum / groundedWheels, 0, 1) : 0,
      surface: dominantSurface,
      scrapeIntensity: this.scrapeIntensity,
      horn: this.lastHorn,
      airborne: groundedWheels === 0,
      groundedWheels,
      wheels: [wheelStates[0], wheelStates[1], wheelStates[2], wheelStates[3]],
    };
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.colliderMeta.clear();
    this.lastImpactTimeByCollider.clear();
    this.activeContacts.clear();
    this.contactSnapshots.clear();
    this.dynamicProps.length = 0;
    this.dynamicPropTransforms.length = 0;
    this.eventQueue.free();
    this.world.free();
  }

  private assertNotDisposed(): void {
    if (this.disposed) {
      throw new Error('DrivingWorldSim has already been disposed.');
    }
  }

  private buildColliderDesc(def: WorldColliderDef): RAPIER.ColliderDesc | null {
    const resolveQuat = (rotation?: Quat, euler?: Vec3): Quat | null => {
      if (rotation) return rotation;
      if (euler) return eulerYXZToQuat(euler[0], euler[1], euler[2]);
      return null;
    };

    switch (def.type) {
      case 'box': {
        const desc = RAPIER.ColliderDesc.cuboid(
          Math.max(0.01, def.halfExtents[0]),
          Math.max(0.01, def.halfExtents[1]),
          Math.max(0.01, def.halfExtents[2]),
        ).setTranslation(def.position[0], def.position[1], def.position[2]);
        const q = resolveQuat(def.rotation, def.euler);
        if (q) desc.setRotation({ x: q[0], y: q[1], z: q[2], w: q[3] });
        return desc;
      }
      case 'cylinder': {
        const desc = RAPIER.ColliderDesc.cylinder(
          Math.max(0.01, def.halfHeight),
          Math.max(0.01, def.radius),
        ).setTranslation(def.position[0], def.position[1], def.position[2]);
        const q = resolveQuat(def.rotation, def.euler);
        if (q) desc.setRotation({ x: q[0], y: q[1], z: q[2], w: q[3] });
        return desc;
      }
      case 'heightfield': {
        const expected = (def.nrows + 1) * (def.ncols + 1);
        if (def.heights.length < expected) {
          throw new Error(
            `Heightfield collider '${def.id ?? 'unnamed'}' expected ${expected} samples, got ${def.heights.length}.`,
          );
        }
        const desc = RAPIER.ColliderDesc.heightfield(
          def.nrows,
          def.ncols,
          def.heights,
          { x: def.scale[0], y: def.scale[1], z: def.scale[2] },
        );
        if (def.position) {
          desc.setTranslation(def.position[0], def.position[1], def.position[2]);
        }
        return desc;
      }
      case 'trimesh': {
        if (def.vertices.length < 9 || def.indices.length < 3) return null;
        const desc = RAPIER.ColliderDesc.trimesh(def.vertices, def.indices);
        if (def.position) {
          desc.setTranslation(def.position[0], def.position[1], def.position[2]);
        }
        if (def.rotation) {
          desc.setRotation({
            x: def.rotation[0],
            y: def.rotation[1],
            z: def.rotation[2],
            w: def.rotation[3],
          });
        }
        return desc;
      }
    }
  }

  private updatePowertrain(
    dt: number,
    throttle: number,
    brake: number,
    handbrake: boolean,
    shiftReq: -1 | 0 | 1,
    forwardSpeedMs: number,
  ): { driveForceTotal: number; serviceBrakeForce: number } {
    const gears = this.config.gearRatios;
    const maxGear = gears.length;
    const idleRpm = this.config.idleRpm;
    const maxRpm = this.config.maxRpm;

    const gearBefore = this.gear;
    let effectiveThrottle = throttle;
    let effectiveBrake = brake;

    if (this.transmission === 'manual') {
      if (shiftReq === 1 && this.gear < maxGear) {
        this.gear += 1;
        this.shiftCooldown = 0.16;
      } else if (shiftReq === -1 && this.gear > -1) {
        this.gear -= 1;
        this.shiftCooldown = 0.16;
      }
    } else {
      // Automatic gearbox with smooth brake-to-reverse logic
      if (this.gear === 0) this.gear = 1;

      if (this.gear === -1) {
        if (throttle > 0.12) {
          if (forwardSpeedMs < -0.7) {
            // Moving backward and hitting throttle -> brake to stop first
            effectiveThrottle = 0;
            effectiveBrake = throttle;
          } else {
            this.gear = 1;
            this.shiftCooldown = 0.2;
          }
        } else if (brake > 0.08) {
          // Pressing brake in reverse accelerates backward
          effectiveThrottle = brake;
          effectiveBrake = 0;
        }
      } else {
        if (brake > 0.15 && throttle < 0.08 && forwardSpeedMs < 0.65) {
          this.gear = -1;
          this.shiftCooldown = 0.2;
          effectiveThrottle = brake;
          effectiveBrake = 0;
        } else if (this.shiftCooldown <= 0) {
          if (this.rpm >= maxRpm * 0.89 && this.gear < maxGear && throttle > 0.2) {
            this.gear += 1;
            this.shiftCooldown = 0.24;
          } else if (
            this.gear > 1
            && (this.rpm < maxRpm * 0.40 || (throttle > 0.85 && this.rpm < maxRpm * 0.56))
          ) {
            this.gear -= 1;
            this.shiftCooldown = 0.22;
          }
        }
      }
    }

    this.lastShiftEvent =
      this.gear > gearBefore ? 'up' : this.gear < gearBefore ? 'down' : null;

    // Compute engine RPM from wheel angular speed + clutch slip
    const drivenRadius = this.avgWheelRadius;
    const currentRatio =
      this.gear === -1
        ? this.config.reverseRatio
        : this.gear === 0
          ? 0
          : gears[clamp(this.gear - 1, 0, maxGear - 1)];

    let targetRpm = idleRpm;
    if (this.gear === 0 || handbrake) {
      targetRpm = idleRpm + effectiveThrottle * (maxRpm - idleRpm) * 0.78;
    } else {
      const wheelRpm = (Math.abs(forwardSpeedMs) / (2 * Math.PI * drivenRadius)) * 60;
      const coupledRpm = wheelRpm * currentRatio * this.config.finalDrive;
      const clutchSlipRpm = idleRpm + effectiveThrottle * 2400;
      const clutchBlend = clamp(Math.abs(forwardSpeedMs) / 4.2, 0, 1);
      targetRpm = Math.max(idleRpm, clutchSlipRpm * (1 - clutchBlend) + coupledRpm * clutchBlend);
    }
    targetRpm = clamp(targetRpm, idleRpm, maxRpm * 1.02);

    const rpmLerp = 1 - Math.exp(-dt * 14);
    this.rpm += (targetRpm - this.rpm) * rpmLerp;

    // Engine torque & wheel tractive force
    const rpmNorm = (this.rpm - idleRpm) / Math.max(1, maxRpm - idleRpm);
    const engineDamageScale = 0.22 + 0.78 * this.health.engineHealth;
    const revLimiterScale = this.rpm >= maxRpm * 0.995 ? 0.15 : 1.0;

    // Turbocharger spool model (spools under load above ~22% RPM, dumps on lift-off or upshift)
    const boostRpmFactor = clamp((rpmNorm - 0.18) / 0.55, 0, 1);
    const targetBoost =
      this.lastShiftEvent === 'up'
        ? 0.08
        : effectiveThrottle * boostRpmFactor * engineDamageScale;
    const boostRate = targetBoost > this.turboBoost ? 3.8 : 9.5;
    this.turboBoost = clamp(
      this.turboBoost + (targetBoost - this.turboBoost) * (1 - Math.exp(-dt * boostRate)),
      0,
      1,
    );

    // Cap torque by peak power curve (P = T * omega) so high gears don't over-accelerate infinitely
    const omegaRadS = Math.max(100, (this.rpm * 2 * Math.PI) / 60);
    const powerLimitedTorque = (this.config.maxPowerKw * 1000) / omegaRadS;
    const baseTorqueNm = Math.min(this.config.maxTorqueNm, powerLimitedTorque * 1.15);
    const engineTorque =
      baseTorqueNm
      * torqueCurveFactor(rpmNorm)
      * effectiveThrottle
      * engineDamageScale
      * revLimiterScale;

    let driveForceTotal = 0;
    if (this.gear !== 0 && currentRatio > 0) {
      const drivetrainEfficiency = 0.86;
      const wheelForce = (engineTorque * currentRatio * this.config.finalDrive * drivetrainEfficiency) / drivenRadius;
      // Scale to match Rapier's engine force units cleanly for snappy, realistic 0-100 km/h (~3.5-5s)
      const sign = this.gear === -1 ? -0.72 : 1.0;
      driveForceTotal = wheelForce * sign;

      // Soft reverse speed cap (~65 km/h)
      if (this.gear === -1 && forwardSpeedMs < -18) {
        driveForceTotal = 0;
      }
    }

    const serviceBrakeForce = effectiveBrake * this.config.maxBrakeForce;
    return { driveForceTotal, serviceBrakeForce };
  }

  private applyAeroAndStabilizers(preVel: Vec3, preQuat: Quat, forwardSpeedMs: number): void {
    const speedSq = preVel[0] * preVel[0] + preVel[1] * preVel[1] + preVel[2] * preVel[2];
    const speed = Math.sqrt(speedSq);

    if (speed > 0.2) {
      // Aerodynamic drag (tuned so supercars reach ~280-320 km/h on the 1.4 km expressway) + rolling resistance
      const dragMag = 0.5 * 1.225 * 0.58 * speedSq + 0.013 * this.config.massKg * GRAVITY;
      const invS = 1 / speed;
      this.chassisBody.addForce(
        {
          x: -preVel[0] * invS * dragMag,
          y: -preVel[1] * invS * dragMag * 0.25,
          z: -preVel[2] * invS * dragMag,
        },
        true,
      );

      // Subtle aerodynamic downforce at speed for planted highway handling
      const downforce = 0.5 * 1.225 * 0.40 * forwardSpeedMs * forwardSpeedMs;
      const localDown = rotateVecByQuat([0, -Math.min(downforce, this.config.massKg * 4.5), 0], preQuat);
      this.chassisBody.addForce({ x: localDown[0], y: localDown[1], z: localDown[2] }, true);
    }

    // Anti-roll stabilizer bars (front & rear axles)
    const antiRollStiffness = this.config.massKg * 2.1;
    const suspLen = (idx: number) =>
      this.vehicle.wheelIsInContact(idx)
        ? (this.vehicle.wheelSuspensionLength(idx) ?? this.wheels[idx].restLength)
        : this.wheels[idx].restLength;

    const frontDiff = suspLen(0) - suspLen(1); // FL - FR (+ means left drooped / rolling right)
    const rearDiff = suspLen(2) - suspLen(3); // RL - RR
    // Positive local Z torque rolls +X (left) upward toward +Y
    const rollTorqueZ = -(frontDiff + rearDiff) * 0.5 * antiRollStiffness;
    if (Math.abs(rollTorqueZ) > 1e-2) {
      const worldTorque = rotateVecByQuat([0, 0, rollTorqueZ], preQuat);
      this.chassisBody.addTorque({ x: worldTorque[0], y: worldTorque[1], z: worldTorque[2] }, true);
    }
  }

  private updateWheelKinematics(
    dt: number,
    forwardSpeedMs: number,
    lateralSpeedMs: number,
    throttle: number,
    brake: number,
    handbrake: boolean,
  ): void {
    const absLat = Math.abs(lateralSpeedMs);
    for (let i = 0; i < 4; i++) {
      const w = this.wheels[i];
      const isRear = !w.cfg.steerable;
      const inContact = this.vehicle.wheelIsInContact(i);
      const wheelHealth = this.health.wheelIntegrity[i];
      const wd = this.wheelDamage[i];

      let angVel = forwardSpeedMs / w.cfg.radius;
      if (handbrake && isRear) {
        angVel = 0;
      } else if (!inContact && w.cfg.driven && throttle > 0.05) {
        angVel = (this.rpm / 60) * 0.5;
      } else if (brake > 0.85 && Math.abs(forwardSpeedMs) > 4) {
        angVel *= 0.35;
      }

      w.angularVelocityRad = angVel;
      w.spinAngleRad += angVel * dt;

      // Estimate responsive, realistic tire slip ratio (0..1) for skidmarks & tire screech audio
      let slip = 0;
      if (inContact) {
        const absFwd = Math.abs(forwardSpeedMs);
        // 1. Lateral slide + high-speed hard cornering load
        const latSlideSlip = absLat > 0.65 ? clamp((absLat - 0.65) / 3.55, 0, 1) : 0;
        const steerDemand = Math.abs(forwardSpeedMs * w.steerAngleRad);
        const cornerLoadSlip =
          steerDemand > 1.9 ? clamp(((steerDemand - 1.9) / 4.0) * 0.78, 0, 0.78) : 0;
        const latSlip = Math.max(latSlideSlip, cornerLoadSlip);

        // 2. Hard braking lockup
        let hardBrakeSlip = 0;
        if (brake > 0.45 && absFwd > 4.5) {
          const brakeNorm = clamp((brake - 0.45) / 0.55, 0, 1);
          const speedNorm = clamp((absFwd - 4.5) / 14, 0, 1);
          hardBrakeSlip = 0.35 + 0.50 * clamp(brakeNorm * 0.65 + speedNorm * 0.35, 0, 1);
        }

        // 3. Full-throttle 1st-gear wheelspin launch / burnout
        let launchSlip = 0;
        if (w.cfg.driven && this.gear !== 0 && throttle > 0.72 && absFwd < 13) {
          const throttleNorm = clamp((throttle - 0.72) / 0.28, 0, 1);
          const speedFade = clamp(1 - Math.max(0, absFwd - 3.5) / 9.5, 0, 1);
          launchSlip = clamp((0.38 + 0.40 * throttleNorm) * (0.55 + 0.45 * speedFade), 0.38, 0.78);
        }

        // 4. Handbrake rear-wheel lock / drift
        const handbrakeSlip = handbrake && isRear && absFwd > 1.2 ? 1.0 : 0;

        slip = clamp(Math.max(latSlip, handbrakeSlip, hardBrakeSlip, launchSlip), 0, 1);
      }
      w.slipRatio = slip;

      // Wheel wobble from structural damage or wheel integrity loss
      const wobbleAmp = Math.max(
        wd.wobbleRad,
        wheelHealth < 0.98 ? (1 - wheelHealth) * 0.14 : 0,
      );
      w.wobbleRad = wobbleAmp > 1e-4 ? wobbleAmp * Math.sin(w.spinAngleRad) : 0;
    }
  }

  private collectImpactEvents(dt: number, preVel: Vec3): PhysicsImpactRecord[] {
    const postVel = this.chassisBody.linvel();
    const dvX = postVel.x - preVel[0];
    const dvY = postVel.y - preVel[1];
    const dvZ = postVel.z - preVel[2];
    const bodyDeltaV = Math.hypot(dvX, dvY, dvZ);
    const bodyPos = this.chassisBody.translation();
    const bodyRot = this.chassisBody.rotation();
    const bodyQuat: Quat = [bodyRot.x, bodyRot.y, bodyRot.z, bodyRot.w];
    const preSpeed = Math.hypot(preVel[0], preVel[1], preVel[2]);

    const records: PhysicsImpactRecord[] = [];
    const seenOther = new Set<number>();

    const emitImpactForPair = (
      otherHandle: number,
      chassisIsFirst: boolean,
      forceImpulse: number,
      fallbackWorldForceDir: Vec3 | null,
    ): void => {
      if (seenOther.has(otherHandle)) return;
      seenOther.add(otherHandle);

      // Debounce rapid repeated solver sub-hits on the exact same collider
      const lastT = this.lastImpactTimeByCollider.get(otherHandle) ?? -10;
      if (this.simTime - lastT < 0.08) return;

      const meta = this.colliderMeta.get(otherHandle);
      const isDrivableGround = meta?.tag ? DRIVABLE_TAGS.has(meta.tag) : false;
      const isDynamicProp = Boolean(meta?.isDynamicProp);
      const propMass = meta?.dynamicPropMass ?? 0;

      // For dynamic props (barrels, crates, cones, barriers), scale impulse by effective reduced mass
      // so hitting a 6kg cone doesn't register like a solid concrete wall, while heavy barriers still hit hard!
      const reducedMass = isDynamicProp
        ? (this.config.massKg * propMass) / Math.max(1, this.config.massKg + propMass)
        : this.config.massKg;
      const bodyImpulse = isDynamicProp
        ? Math.max(bodyDeltaV * this.config.massKg, preSpeed * reducedMass * 1.15)
        : bodyDeltaV * this.config.massKg;
      const impulse = Math.max(forceImpulse, bodyImpulse * 0.85);

      // Inspect exact contact manifold for contact point & normal
      let localPoint: Vec3 | null = null;
      let localNormalInward: Vec3 | null = null;
      let manifoldImpulse = 0;

      const otherCollider = this.world.getCollider(otherHandle);
      if (otherCollider) {
        this.world.contactPair(this.chassisCollider, otherCollider, (manifold, flipped) => {
          const n = manifold.numContacts();
          if (n <= 0) return;

          let bestIdx = 0;
          let bestImp = -1;
          for (let k = 0; k < n; k++) {
            const imp = manifold.contactImpulse(k);
            if (imp > bestImp) {
              bestImp = imp;
              bestIdx = k;
            }
          }
          manifoldImpulse = Math.max(manifoldImpulse, bestImp);

          const pt = flipped
            ? manifold.localContactPoint2(bestIdx)
            : manifold.localContactPoint1(bestIdx);
          const nrm = flipped ? manifold.localNormal2() : manifold.localNormal1();

          if (pt) {
            localPoint = [pt.x, pt.y + this.chassisColliderOffsetY, pt.z];
          }
          if (nrm) {
            // Manifold localNormal points outward from our collider; negate to get inward direction.
            localNormalInward = normalizeVec3([-nrm.x, -nrm.y, -nrm.z], [0, 0, -1]);
          }
        });
      }

      const finalImpulse = isDynamicProp
        ? Math.min(Math.max(impulse, manifoldImpulse), preSpeed * reducedMass * 1.85 + 250)
        : Math.max(impulse, manifoldImpulse);

      // If the bodies bounced apart on this exact step, fall back to the contact manifold snapshotted
      // when contact began on the previous step.
      const snapshot = this.contactSnapshots.get(otherHandle);
      if (!localPoint && snapshot) {
        localPoint = [snapshot.localPoint[0], snapshot.localPoint[1], snapshot.localPoint[2]];
      }
      if (!localNormalInward && snapshot) {
        localNormalInward = [
          snapshot.localNormalInward[0],
          snapshot.localNormalInward[1],
          snapshot.localNormalInward[2],
        ];
      }

      // Determine world & local inward normal (force pushing INTO the chassis)
      if (!localNormalInward) {
        const worldDir = fallbackWorldForceDir
          ? normalizeVec3(
              [
                chassisIsFirst ? -fallbackWorldForceDir[0] : fallbackWorldForceDir[0],
                chassisIsFirst ? -fallbackWorldForceDir[1] : fallbackWorldForceDir[1],
                chassisIsFirst ? -fallbackWorldForceDir[2] : fallbackWorldForceDir[2],
              ],
              [dvX, dvY, dvZ],
            )
          : normalizeVec3([dvX, dvY, dvZ], [-preVel[0], -preVel[1], -preVel[2]]);
        localNormalInward = normalizeVec3(rotateVecByInvQuat(worldDir, bodyQuat), [0, 0, -1]);
      }

      // Compute closing speed along the inward normal
      const worldNormal = normalizeVec3(rotateVecByQuat(localNormalInward, bodyQuat), [0, 0, -1]);
      const closingAlongNormal = -(
        preVel[0] * worldNormal[0]
        + preVel[1] * worldNormal[1]
        + preVel[2] * worldNormal[2]
      );
      const relativeSpeed = isDrivableGround
        ? Math.max(0, closingAlongNormal)
        : isDynamicProp
          ? Math.max(Math.abs(closingAlongNormal), preSpeed * 0.85)
          : Math.max(
              Math.abs(closingAlongNormal),
              bodyDeltaV,
              finalImpulse / this.config.massKg,
            );

      // Give knocked dynamic props an energetic scatter & tumble kick on hit so barrels/crates/cones
      // fly cleanly instead of wedging under the bumper!
      if (isDynamicProp && meta?.dynamicPropBody && relativeSpeed > 2.5) {
        const propBody = meta.dynamicPropBody;
        propBody.wakeUp();
        const launchSpeed = clamp(relativeSpeed * 0.65, 2.5, 22);
        const massScale = clamp(propMass, 4, 260);
        const kickFactor = propMass <= 180 ? 0.55 : 0.25;
        const outwardX = -worldNormal[0];
        const outwardZ = -worldNormal[2];
        propBody.applyImpulse(
          {
            x: (outwardX * launchSpeed + preVel[0] * 0.35) * massScale * kickFactor,
            y: clamp(launchSpeed * 0.36, 1.4, 7.5) * massScale * kickFactor,
            z: (outwardZ * launchSpeed + preVel[2] * 0.35) * massScale * kickFactor,
          },
          true,
        );
        propBody.applyTorqueImpulse(
          {
            x: (outwardZ * 0.6 + 0.35) * massScale * 0.22,
            y: ((otherHandle % 3) - 1) * massScale * 0.18,
            z: (-outwardX * 0.6) * massScale * 0.22,
          },
          true,
        );
      }

      // Ignore gentle scrapes and normal ground/ramp contact unless it's a heavy slam.
      // Dynamic props have a lower impulse floor so knocking over barrels/crates/barriers triggers sparks + sound.
      const minSpeed = isDrivableGround
        ? Math.max(8.5, this.config.impactSpeedThreshold * 3.5)
        : isDynamicProp
          ? 2.8
          : this.config.impactSpeedThreshold;
      const minImpulse = isDrivableGround
        ? this.config.impactImpulseThreshold * 3.2
        : isDynamicProp
          ? 120
          : this.config.impactImpulseThreshold;

      if (finalImpulse < minImpulse || relativeSpeed < minSpeed) {
        return;
      }

      // Fallback localPoint projected onto chassis outer shell if manifold already separated
      if (!localPoint) {
        localPoint = [
          -localNormalInward[0] * this.chassisHalfExtents[0],
          clamp(
            this.chassisColliderOffsetY - localNormalInward[1] * this.chassisHalfExtents[1],
            0.25,
            this.config.chassisSize[1],
          ),
          -localNormalInward[2] * this.chassisHalfExtents[2],
        ];
      }

      // Sanity-check inward direction: localNormal must point toward chassis center from localPoint
      const toCenter: Vec3 = [
        -localPoint[0],
        this.chassisColliderOffsetY - localPoint[1],
        -localPoint[2],
      ];
      const dot =
        toCenter[0] * localNormalInward[0]
        + toCenter[1] * localNormalInward[1]
        + toCenter[2] * localNormalInward[2];
      if (dot < 0) {
        localNormalInward = [
          -localNormalInward[0],
          -localNormalInward[1],
          -localNormalInward[2],
        ];
      }

      const finalWorldNormal = normalizeVec3(rotateVecByQuat(localNormalInward, bodyQuat), [0, 1, 0]);
      const rotLocalPt = rotateVecByQuat(localPoint, bodyQuat);
      const worldPoint: Vec3 = [
        bodyPos.x + rotLocalPt[0],
        bodyPos.y + rotLocalPt[1],
        bodyPos.z + rotLocalPt[2],
      ];

      // Visceral crash dynamics on solid static obstacle impacts:
      // 1) Plastic crush absorption — damp excessive elastic bounce-back along inward normal so
      //    smashing a wall crunches in and stops rather than bouncing off like rubber.
      // 2) Off-center corner yaw spin + nose/rear pitch kick + side roll kick.
      if (!isDynamicProp && !isDrivableGround && relativeSpeed > 4.5) {
        const curV = this.chassisBody.linvel();
        const reboundAlongNormal =
          curV.x * finalWorldNormal[0]
          + curV.y * finalWorldNormal[1]
          + curV.z * finalWorldNormal[2];
        if (reboundAlongNormal > 0.35) {
          // Absorb ~60% of rebound velocity into sheet-metal deformation energy
          const absorb = reboundAlongNormal * 0.62;
          this.chassisBody.setLinvel(
            {
              x: curV.x - finalWorldNormal[0] * absorb,
              y: curV.y - finalWorldNormal[1] * absorb * 0.5,
              z: curV.z - finalWorldNormal[2] * absorb,
            },
            true,
          );
        }

        // Physical lever arm r = localPoint - COM, torque impulse = r x J_inward
        const rx = localPoint[0] - this.chassisComLocal[0];
        const ry = localPoint[1] - this.chassisComLocal[1];
        const rz = localPoint[2] - this.chassisComLocal[2];
        const impactScale = clamp(finalImpulse / (this.config.massKg * 12), 0.15, 2.4);

        // Cross product r x localNormalInward gives physically accurate spin direction
        const crossX = ry * localNormalInward[2] - rz * localNormalInward[1];
        const crossY = rz * localNormalInward[0] - rx * localNormalInward[2];
        const crossZ = rx * localNormalInward[1] - ry * localNormalInward[0];

        // Nose-on hit (localPoint.z > 0.7, inward -Z) kicks the tail up (+X pitch); rear hit (-Z) pitches nose up (-X)
        const nosePitchKick =
          Math.abs(localNormalInward[2]) > 0.5 && Math.abs(localPoint[2]) > 0.7
            ? Math.sign(localPoint[2]) * 0.65 * impactScale
            : 0;

        // Glancing corner hits whip the car into a dramatic yaw spin; side hits add subtle roll kick
        const localAngKick: Vec3 = [
          clamp((crossX * 0.45 + nosePitchKick) * 1.15, -2.4, 2.4),
          clamp(crossY * impactScale * 1.55, -3.6, 3.6),
          clamp(crossZ * impactScale * 0.85, -1.8, 1.8),
        ];
        const worldAngKick = rotateVecByQuat(localAngKick, bodyQuat);
        const curW = this.chassisBody.angvel();
        this.chassisBody.setAngvel(
          {
            x: clamp(curW.x + worldAngKick[0], -5.5, 5.5),
            y: clamp(curW.y + worldAngKick[1], -6.5, 6.5),
            z: clamp(curW.z + worldAngKick[2], -5.0, 5.0),
          },
          true,
        );
      }

      const gForce = clamp(finalImpulse / (this.config.massKg * GRAVITY * Math.max(dt, 1 / 60)), 0.4, 65);
      this.lastImpactTimeByCollider.set(otherHandle, this.simTime);

      const event: ImpactEvent = {
        localPoint,
        localNormal: localNormalInward,
        impulse: finalImpulse,
        relativeSpeed,
      };

      records.push({
        event,
        worldPoint,
        worldNormal: finalWorldNormal,
        gForce,
        colliderId: meta?.id,
        colliderTag: meta?.tag,
        isDynamicProp: isDynamicProp || undefined,
        dynamicPropKind: meta?.dynamicPropKind,
      });
    };

    // 1. Drain contact-force events (sustained & high-force contacts)
    this.eventQueue.drainContactForceEvents((ev) => {
      const h1 = ev.collider1();
      const h2 = ev.collider2();
      let otherHandle: number;
      let chassisIsFirst: boolean;
      if (h1 === this.chassisCollider.handle) {
        otherHandle = h2;
        chassisIsFirst = true;
      } else if (h2 === this.chassisCollider.handle) {
        otherHandle = h1;
        chassisIsFirst = false;
      } else {
        return;
      }

      const totalForce = ev.totalForce();
      const maxForceDir = ev.maxForceDirection();
      const forceImpulse = ev.totalForceMagnitude() * this.world.numSolverIterations * dt;
      const fallbackDir: Vec3 =
        Math.hypot(maxForceDir.x, maxForceDir.y, maxForceDir.z) > 0.1
          ? [maxForceDir.x, maxForceDir.y, maxForceDir.z]
          : [totalForce.x, totalForce.y, totalForce.z];

      emitImpactForPair(otherHandle, chassisIsFirst, forceImpulse, fallbackDir);
    });

    // 2. Drain collision start/end events and maintain activeContacts + manifold snapshots.
    // On a 1-frame high-speed bounce (e.g. hitting a pole or barrier), contact starts on step N
    // (small dv) and resolves + separates on step N+1 (large dv, started=false).
    const endedContacts: number[] = [];
    const snapshotManifold = (otherHandle: number): void => {
      const otherCollider = this.world.getCollider(otherHandle);
      if (!otherCollider) return;
      this.world.contactPair(this.chassisCollider, otherCollider, (manifold, flipped) => {
        if (manifold.numContacts() <= 0) return;
        const pt = flipped ? manifold.localContactPoint2(0) : manifold.localContactPoint1(0);
        const nrm = flipped ? manifold.localNormal2() : manifold.localNormal1();
        if (pt && nrm) {
          this.contactSnapshots.set(otherHandle, {
            localPoint: [pt.x, pt.y + this.chassisColliderOffsetY, pt.z],
            localNormalInward: normalizeVec3([-nrm.x, -nrm.y, -nrm.z], [0, 0, -1]),
          });
        }
      });
    };

    this.eventQueue.drainCollisionEvents((h1, h2, started) => {
      let otherHandle: number;
      let chassisIsFirst: boolean;
      if (h1 === this.chassisCollider.handle) {
        otherHandle = h2;
        chassisIsFirst = true;
      } else if (h2 === this.chassisCollider.handle) {
        otherHandle = h1;
        chassisIsFirst = false;
      } else {
        return;
      }

      if (started) {
        this.activeContacts.add(otherHandle);
        snapshotManifold(otherHandle);
        emitImpactForPair(otherHandle, chassisIsFirst, bodyDeltaV * this.config.massKg, null);
      } else {
        // Evaluate BEFORE removing so a 1-frame bounce crash emits on the exact impulse step!
        emitImpactForPair(otherHandle, chassisIsFirst, bodyDeltaV * this.config.massKg, null);
        endedContacts.push(otherHandle);
      }
    });

    // 3. Inspect any still-active non-drivable contacts on high-deltaV steps
    if (bodyDeltaV >= this.config.impactSpeedThreshold) {
      for (const otherHandle of this.activeContacts) {
        const otherMeta = this.colliderMeta.get(otherHandle);
        if (otherMeta?.tag && DRIVABLE_TAGS.has(otherMeta.tag)) continue;
        emitImpactForPair(otherHandle, true, bodyDeltaV * this.config.massKg, null);
      }
    }

    for (const h of endedContacts) {
      this.activeContacts.delete(h);
      this.contactSnapshots.delete(h);
    }

    return records;
  }
}
