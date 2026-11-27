import type { Vec3, VehicleManifest } from '@blend-garage/vehicle-core';
import type {
  DrivetrainType,
  VehiclePhysicsConfig,
  WheelCorner,
  WheelPhysicsConfig,
} from './types.js';

export interface RigWheelInput {
  corner: WheelCorner | 'unknown';
  center: Vec3;
  radius: number;
  width: number;
}

export interface VehicleConfigOverrides extends Partial<VehiclePhysicsConfig> {
  /** Actual VehicleRig bounds size [width, height, length] in meters (preferred over manifest bounds when available). */
  rigSize?: Vec3;
  /** Actual detected wheel fits from VehicleRig in car-local space (+Z nose, +X left, y=0 ground). */
  rigWheels?: RigWheelInput[];
}

function clamp(v: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, v));
}

function isDriven(corner: WheelCorner, drivetrain: DrivetrainType): boolean {
  if (drivetrain === 'awd') return true;
  if (drivetrain === 'fwd') return corner === 'FL' || corner === 'FR';
  return corner === 'RL' || corner === 'RR';
}

function estimateMassKg(size: Vec3): number {
  // Estimate plausible vehicle mass from footprint volume: compact sports car ~1320kg, large coupe/SUV ~1850kg.
  const volume = Math.max(4, size[0] * size[1] * size[2]);
  return Math.round(clamp(920 + volume * 52, 1180, 2150));
}

function buildFourWheels(
  size: Vec3,
  rawWheels: RigWheelInput[],
  drivetrain: DrivetrainType,
): [WheelPhysicsConfig, WheelPhysicsConfig, WheelPhysicsConfig, WheelPhysicsConfig] {
  const halfTrackDefault = clamp(size[0] * 0.41, 0.65, 1.05);
  const frontZDefault = clamp(size[2] * 0.30, 1.05, 1.85);
  const rearZDefault = -clamp(size[2] * 0.30, 1.05, 1.85);
  const defaultRadius = clamp(size[1] * 0.26, 0.29, 0.42);
  const defaultWidth = clamp(size[0] * 0.13, 0.21, 0.34);

  const byCorner = new Map<WheelCorner, RigWheelInput>();
  for (const w of rawWheels) {
    if (w.corner === 'FL' || w.corner === 'FR' || w.corner === 'RL' || w.corner === 'RR') {
      byCorner.set(w.corner, w);
    }
  }

  // Ensure canonical car-local signs: +X is left (FL, RL), -X is right (FR, RR), +Z is front (FL, FR), -Z is rear (RL, RR).
  const makeWheel = (corner: WheelCorner): WheelPhysicsConfig => {
    const found = byCorner.get(corner);
    const isFront = corner === 'FL' || corner === 'FR';
    const isLeft = corner === 'FL' || corner === 'RL';

    const radius = found && Number.isFinite(found.radius) && found.radius > 0.15
      ? clamp(found.radius, 0.22, 0.55)
      : defaultRadius;
    const width = found && Number.isFinite(found.width) && found.width > 0.1
      ? clamp(found.width, 0.16, 0.45)
      : defaultWidth;

    let x = found ? Math.abs(found.center[0]) : halfTrackDefault;
    let z = found ? Math.abs(found.center[2]) : (isFront ? frontZDefault : Math.abs(rearZDefault));
    if (!Number.isFinite(x) || x < 0.35) x = halfTrackDefault;
    if (!Number.isFinite(z) || z < 0.6) z = isFront ? frontZDefault : Math.abs(rearZDefault);

    const signedX = isLeft ? x : -x;
    const signedZ = isFront ? z : -z;
    const y = radius;

    return {
      corner,
      position: [signedX, y, signedZ],
      radius,
      width,
      steerable: isFront,
      driven: isDriven(corner, drivetrain),
    };
  };

  return [makeWheel('FL'), makeWheel('FR'), makeWheel('RL'), makeWheel('RR')];
}

/**
 * Builds a well-tuned `VehiclePhysicsConfig` from a Blend Garage `VehicleManifest`
 * (and optional live `VehicleRig` measurements / overrides).
 */
export function createVehiclePhysicsConfig(
  manifest: Pick<VehicleManifest, 'bounds' | 'wheels'>,
  overrides: VehicleConfigOverrides = {},
): VehiclePhysicsConfig {
  const size: Vec3 = overrides.rigSize ?? manifest.bounds.size ?? [1.92, 1.32, 4.48];
  const drivetrain: DrivetrainType = overrides.drivetrain ?? 'awd';
  const rawWheels: RigWheelInput[] = overrides.rigWheels
    ?? manifest.wheels.map((w) => ({
      corner: w.corner,
      center: w.center,
      radius: w.radius,
      width: w.width,
    }));

  const wheels = overrides.wheels ?? buildFourWheels(size, rawWheels, drivetrain);
  const massKg = overrides.massKg ?? estimateMassKg(size);

  return {
    massKg,
    chassisSize: [
      clamp(size[0], 1.4, 2.6),
      clamp(size[1], 1.0, 2.3),
      clamp(size[2], 3.2, 6.2),
    ],
    centerOfMassOffset: overrides.centerOfMassOffset ?? [0, clamp(size[1] * 0.31, 0.36, 0.56), 0.04],
    wheels,
    drivetrain,
    maxPowerKw: overrides.maxPowerKw ?? 385,
    maxTorqueNm: overrides.maxTorqueNm ?? 610,
    maxRpm: overrides.maxRpm ?? 7800,
    idleRpm: overrides.idleRpm ?? 900,
    gearRatios: overrides.gearRatios ?? [3.42, 2.24, 1.60, 1.20, 0.94, 0.74],
    reverseRatio: overrides.reverseRatio ?? 3.15,
    finalDrive: overrides.finalDrive ?? 3.45,
    transmission: overrides.transmission ?? 'auto',
    suspensionRestLength: overrides.suspensionRestLength ?? 0.29,
    suspensionTravel: overrides.suspensionTravel ?? 0.16,
    suspensionStiffness: overrides.suspensionStiffness ?? 30,
    suspensionDampingCompression: overrides.suspensionDampingCompression ?? 4.2,
    suspensionDampingRelaxation: overrides.suspensionDampingRelaxation ?? 5.2,
    maxSteerAngleRad: overrides.maxSteerAngleRad ?? 0.58,
    tireGrip: overrides.tireGrip ?? 2.75,
    sideFrictionStiffness: overrides.sideFrictionStiffness ?? 1.4,
    maxBrakeForce: overrides.maxBrakeForce ?? 76,
    rideHeightOffset: overrides.rideHeightOffset ?? 0,
    spawnPosition: overrides.spawnPosition ?? [0, 0.15, 0],
    spawnHeadingRad: overrides.spawnHeadingRad ?? 0,
    impactImpulseThreshold: overrides.impactImpulseThreshold ?? 900,
    impactSpeedThreshold: overrides.impactSpeedThreshold ?? 2.2,
  };
}
