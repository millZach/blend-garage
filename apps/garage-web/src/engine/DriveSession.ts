import * as THREE from 'three';
import { createHealthyMechanicalHealth, RealDamageSimulator, type MechanicalHealth } from '@blend-garage/damage-bridge';
import type { CarBuild } from '@blend-garage/vehicle-core';
import {
  createVehiclePhysicsConfig,
  DriveInputController,
  DrivingWorldSim,
  type DriveInputFrame,
  type VehiclePhysicsState,
} from '@blend-garage/world-racing';
import type { SoundEngine } from './audio';
import { clamp, damp, lerp } from './math';
import type { DriveCameraView, DriveSnapshot } from './types';
import type { VehicleRig, WheelDriveState } from './vehicle/VehicleRig';
import { OpenWorld, type SpawnName, type WorldSkidInput } from './world';

const FIXED_DT = 1 / 60;
const MAX_SUBSTEPS = 3;
const CAMERA_ORDER: DriveCameraView[] = ['chase', 'chase-far', 'hood', 'bumper', 'orbit'];
const SNAPSHOT_INTERVAL = 1 / 20;

export interface DriveSessionOptions {
  scene: THREE.Scene;
  renderer: THREE.WebGLRenderer;
  canvas: HTMLCanvasElement;
  rig: VehicleRig;
  build: CarBuild;
  sound: SoundEngine;
  width: number;
  height: number;
  onExit: () => void;
  onNotify: (text: string) => void;
}

const _carPos = new THREE.Vector3();
const _carQuat = new THREE.Quaternion();
const _forward = new THREE.Vector3();
const _up = new THREE.Vector3();
const _right = new THREE.Vector3();
const _desiredCamPos = new THREE.Vector3();
const _desiredLookAt = new THREE.Vector3();
const _hoodLocal = new THREE.Vector3();
const _hoodWorld = new THREE.Vector3();
const _shakeVec = new THREE.Vector3();

function isSpawnName(name: string | undefined): name is SpawnName {
  return name === 'start' || name === 'highway' || name === 'proving-grounds' || name === 'canyon';
}

/**
 * Pure TypeScript Open-World driving session: owns the outdoor OpenWorld, Rapier vehicle physics,
 * real-time crash deformation simulator, keyboard/gamepad input controller, procedural SoundEngine
 * telemetry feed, and smooth interpolated chase cameras. Zero React imports.
 */
export class DriveSession {
  readonly camera: THREE.PerspectiveCamera;

  private readonly world: OpenWorld;
  private readonly sim: DrivingWorldSim;
  private readonly damageSim: RealDamageSimulator;
  private readonly input: DriveInputController;
  private readonly rig: VehicleRig;
  private readonly sound: SoundEngine;
  private readonly canvas: HTMLCanvasElement;
  private readonly onExit: () => void;
  private readonly onNotify: (text: string) => void;

  private health: MechanicalHealth = createHealthyMechanicalHealth();
  private state: VehiclePhysicsState;
  private cameraView: DriveCameraView = 'chase';
  private spawnName: string = 'start';
  private lightsOn: boolean;
  private inputSource: 'keyboard' | 'gamepad' = 'keyboard';
  private gamepadName: string | null = null;
  private lastImpactG = 0;
  private totalImpacts = 0;
  private detachedPartsCount = 0;

  private accumulator = 0;
  private elapsed = 0;
  private snapshotTimer = 0;
  private snapshotDirty = true;
  private disposed = false;

  // Pre-allocated per-frame wheel & skid buffers to avoid GC pressure.
  private readonly wheelStatesBuf: WheelDriveState[] = [
    { corner: 'FL', suspensionY: 0, steerRad: 0, spinRad: 0, wobbleRad: 0 },
    { corner: 'FR', suspensionY: 0, steerRad: 0, spinRad: 0, wobbleRad: 0 },
    { corner: 'RL', suspensionY: 0, steerRad: 0, spinRad: 0, wobbleRad: 0 },
    { corner: 'RR', suspensionY: 0, steerRad: 0, spinRad: 0, wobbleRad: 0 },
  ];
  private readonly skidMarksBuf: WorldSkidInput[] = [];

  // Smooth chase & orbit camera state
  private readonly camPos = new THREE.Vector3();
  private readonly camTarget = new THREE.Vector3();
  private camInitialized = false;
  private cameraShake = 0;
  private orbitYaw = Math.PI * 0.18;
  private orbitPitch = 0.28;
  private orbitDistance = 6.2;
  private orbitDragging = false;
  private lastPointer = { x: 0, y: 0 };

  private constructor(
    options: DriveSessionOptions,
    world: OpenWorld,
    sim: DrivingWorldSim,
    damageSim: RealDamageSimulator,
    input: DriveInputController,
    initialState: VehiclePhysicsState,
  ) {
    this.rig = options.rig;
    this.sound = options.sound;
    this.canvas = options.canvas;
    this.onExit = options.onExit;
    this.onNotify = options.onNotify;
    this.world = world;
    this.sim = sim;
    this.damageSim = damageSim;
    this.input = input;
    this.state = initialState;
    this.lightsOn = options.build.lightsOn;

    this.camera = new THREE.PerspectiveCamera(56, Math.max(1, options.width) / Math.max(1, options.height), 0.15, 1600);
    this.orbitDistance = clamp(this.rig.size.z * 1.45, 5.2, 8.5);

    this.rig.setDriveShadowMode(true);
    this.rig.setDriveLights(this.lightsOn);
    this.syncRigFromState(initialState);
    this.snapCameraToState(initialState);

    this.sound.setCarProfile({ id: this.rig.manifest.id, name: this.rig.manifest.name });
    this.sound.setMode('drive');
    this.sound.playIgnition();

    this.canvas.addEventListener('pointerdown', this.handlePointerDown);
    this.canvas.addEventListener('pointermove', this.handlePointerMove);
    this.canvas.addEventListener('pointerup', this.handlePointerUp);
    this.canvas.addEventListener('pointercancel', this.handlePointerUp);
    this.canvas.addEventListener('wheel', this.handleWheel, { passive: true });
  }

  /** Creates and mounts the Open World, physics world, damage simulator, and input bindings. */
  static async create(options: DriveSessionOptions): Promise<DriveSession> {
    const { scene, renderer, rig, build } = options;

    const world = new OpenWorld();
    world.mount(scene, renderer);

    const startSpawn = world.getSpawnPoint('start');
    const wheelSpecs = rig.getWheelSpecs();
    const physicsConfig = createVehiclePhysicsConfig(rig.manifest, {
      rigSize: [rig.size.x, rig.size.y, rig.size.z],
      rigWheels: wheelSpecs.map((w) => ({
        corner: w.corner,
        center: w.center,
        radius: w.radius,
        width: w.width,
      })),
      rideHeightOffset: build.stance.rideHeightOffset,
      spawnPosition: [startSpawn.position[0], startSpawn.position[1] + 0.12, startSpawn.position[2]],
      spawnHeadingRad: startSpawn.headingRad,
    });

    const sim = await DrivingWorldSim.create(physicsConfig, world.getColliders());

    const damageSim = new RealDamageSimulator();
    await damageSim.init({
      carId: rig.manifest.id,
      massKg: physicsConfig.massKg,
      meshes: rig.extractDeformableMeshes(),
    });

    const input = new DriveInputController();
    input.attach(window);

    // Let suspension settle cleanly onto the asphalt with handbrake (never brake, which engages auto-reverse).
    let state = sim.getState();
    const parkedControl = { throttle: 0, brake: 0, steer: 0, handbrake: true };
    for (let i = 0; i < 10; i++) {
      state = sim.step(FIXED_DT, parkedControl).state;
    }
    state = sim.step(FIXED_DT, { throttle: 0, brake: 0, steer: 0, handbrake: false }).state;

    return new DriveSession(options, world, sim, damageSim, input, state);
  }

  resize(width: number, height: number): void {
    this.camera.aspect = Math.max(1, width) / Math.max(1, height);
    this.camera.updateProjectionMatrix();
  }

  cycleCamera(): void {
    const idx = CAMERA_ORDER.indexOf(this.cameraView);
    this.cameraView = CAMERA_ORDER[(idx + 1) % CAMERA_ORDER.length];
    this.camInitialized = false;
    this.snapshotDirty = true;
    this.sound.playCameraSwoosh();
  }

  toggleLights(): void {
    this.lightsOn = !this.lightsOn;
    this.rig.setDriveLights(this.lightsOn);
    this.snapshotDirty = true;
    this.sound.playLightSwitch();
  }

  repairCar(): void {
    const result = this.damageSim.reset();
    this.rig.applyDamageResult(result);
    this.rig.resetAllDamage();
    this.health = result.health;
    this.sim.setMechanicalHealth(result.health);
    this.lastImpactG = 0;
    this.totalImpacts = 0;
    this.detachedPartsCount = 0;
    this.cameraShake = 0;
    this.world.clearFx();
    this.sound.playRepair();
    this.snapshotDirty = true;
  }

  resetCar(spawnName?: string): void {
    const pose = isSpawnName(spawnName)
      ? this.world.getSpawnPoint(spawnName)
      : this.world.nearestRoadPose(this.state.position[0], this.state.position[2]);

    if (isSpawnName(spawnName)) this.spawnName = spawnName;
    this.state = this.sim.resetPose([pose.position[0], pose.position[1] + 0.14, pose.position[2]], pose.headingRad);
    this.accumulator = 0;
    this.cameraShake = 0;
    this.world.clearFx();
    this.syncRigFromState(this.state);
    this.snapCameraToState(this.state);
    this.sound.playReset();
    this.snapshotDirty = true;
  }

  /**
   * Advances physics, crash deformation, car rig (with smooth fixed-step pose interpolation),
   * world FX, procedural audio, and driving camera for one frame.
   * Returns a fresh `DriveSnapshot` when HUD state should refresh, or `null` to skip React re-renders.
   */
  update(dt: number): DriveSnapshot | null {
    if (this.disposed) return null;
    const clampedDt = clamp(dt, 0.001, 0.05);
    this.elapsed += clampedDt;

    const frame: DriveInputFrame = this.input.poll(clampedDt);
    if (frame.activeSource !== this.inputSource || frame.gamepadName !== this.gamepadName) {
      this.inputSource = frame.activeSource;
      this.gamepadName = frame.gamepadName;
      this.snapshotDirty = true;
    }

    if (frame.actions.exitDrive) {
      this.onExit();
      return null;
    }
    if (frame.actions.repair) {
      this.repairCar();
      this.onNotify('Car repaired to 100%.');
    }
    if (frame.actions.reset) {
      this.resetCar();
      this.onNotify('Reset onto nearest road.');
    }
    if (frame.actions.cycleCamera) {
      this.cycleCamera();
    }
    if (frame.actions.toggleHeadlights) {
      this.toggleLights();
    }
    if (frame.actions.toggleTransmission) {
      const next = this.state.transmission === 'auto' ? 'manual' : 'auto';
      this.sim.setTransmissionMode(next);
      this.sound.playUiClick();
      this.onNotify(`Transmission: ${next === 'manual' ? 'Manual (Q/E or LB/RB)' : 'Automatic'}.`);
    }

    const prevGear = this.state.gear;
    const prevHandbrake = this.state.handbrake;
    const prevHorn = this.state.horn;

    // Fixed-timestep physics & damage loop
    this.accumulator = Math.min(this.accumulator + clampedDt, FIXED_DT * MAX_SUBSTEPS);
    let substeps = 0;
    let shiftPending = frame.control.shift ?? 0;
    let shiftEvent: 'up' | 'down' | null = null;

    while (this.accumulator >= FIXED_DT && substeps < MAX_SUBSTEPS) {
      const stepInput = shiftPending !== 0 ? { ...frame.control, shift: shiftPending } : { ...frame.control, shift: 0 as const };
      shiftPending = 0;

      const stepResult = this.sim.step(FIXED_DT, stepInput);
      this.state = stepResult.state;
      if (stepResult.state.shiftEvent) shiftEvent = stepResult.state.shiftEvent;
      this.damageSim.step(FIXED_DT);

      if (stepResult.impacts.length > 0) {
        for (const impact of stepResult.impacts) {
          const dmg = this.damageSim.applyImpact(impact.event);
          this.rig.applyDamageResult(dmg);
          this.health = dmg.health;
          this.sim.setMechanicalHealth(dmg.health);

          const newlyDetached =
            (dmg.detachedImpulses !== undefined && dmg.detachedImpulses.length > 0) ||
            dmg.detachedPartIds.length > this.detachedPartsCount;
          this.detachedPartsCount = dmg.detachedPartIds.length;

          this.sound.playImpact({
            gForce: impact.gForce,
            speedMps: impact.event.relativeSpeed,
            glassBreak: impact.gForce >= 18,
            panelDetached: newlyDetached,
          });
          if (newlyDetached) this.sound.playPartDetach();

          const sparkIntensity = clamp(impact.gForce / 14, 0.4, 2.2);
          this.world.emitCrashSparks(impact.worldPoint, impact.worldNormal, sparkIntensity);
          this.cameraShake = Math.min(1, this.cameraShake + clamp(impact.gForce / 18, 0.16, 0.85));
          this.input.triggerRumble(clamp(impact.gForce / 15, 0.22, 1.0), clamp(Math.round(impact.gForce * 16), 90, 380));

          this.lastImpactG = impact.gForce;
          this.totalImpacts += 1;
          this.snapshotDirty = true;
        }
      }

      this.accumulator -= FIXED_DT;
      substeps += 1;
    }

    if (shiftEvent) {
      this.sound.playShift(shiftEvent, this.state.rpm);
    }

    // Feed live telemetry to procedural SoundEngine (engine, turbo/BOV, tires, surface, wind, horn, scrape).
    this.sound.updateDrive({
      dt: clampedDt,
      speedMps: Math.abs(this.state.forwardSpeedMs),
      rpm: this.state.rpm,
      idleRpm: this.state.idleRpm,
      redlineRpm: this.state.redlineRpm,
      gear: this.state.gear,
      throttle: this.state.throttle,
      brake: this.state.brake,
      handbrake: this.state.handbrake,
      turboBoost: this.state.turboBoost,
      slipRatio: this.state.slipRatio,
      wheelLoad: this.state.wheelLoad,
      surface: this.state.surface,
      cameraMode: this.cameraView,
      airborne: this.state.airborne,
      hornActive: this.state.horn,
      scrapeIntensity: this.state.scrapeIntensity,
      engineHealth: this.health.engineHealth,
    });

    if (this.state.gear !== prevGear || this.state.handbrake !== prevHandbrake || this.state.horn !== prevHorn) {
      this.snapshotDirty = true;
    }

    // Interpolate visual car pose & wheels between previous and current physics ticks for jitter-free motion.
    const alpha = clamp(this.accumulator / FIXED_DT, 0, 1);
    const renderState = this.sim.getInterpolatedState(alpha);

    this.syncRigFromState(renderState);
    this.rig.update(clampedDt);

    // Update OpenWorld sun shadows, engine smoke, and tire skidmarks.
    _carPos.set(renderState.position[0], renderState.position[1], renderState.position[2]);
    _carQuat.set(renderState.quaternion[0], renderState.quaternion[1], renderState.quaternion[2], renderState.quaternion[3]);

    _hoodLocal.set(0, this.rig.size.y * 0.56, this.rig.size.z * 0.34);
    _hoodWorld.copy(_hoodLocal).applyQuaternion(_carQuat).add(_carPos);

    this.skidMarksBuf.length = 0;
    const speedMs = Math.abs(this.state.forwardSpeedMs);
    if (speedMs > 1.8) {
      for (let i = 0; i < this.state.wheels.length; i++) {
        const w = this.state.wheels[i];
        if (!w.inContact || !w.contactPoint) continue;
        const slipping = w.slipRatio > 0.34 || (this.state.handbrake && speedMs > 3.5 && (w.corner === 'RL' || w.corner === 'RR'));
        if (slipping) {
          this.skidMarksBuf.push({
            wheelKey: w.corner,
            contactPoint: w.contactPoint,
            headingRad: renderState.headingRad,
            width: 0.28,
            opacity: clamp(Math.max(w.slipRatio, this.state.handbrake ? 0.72 : 0.45), 0.25, 0.8),
          });
        }
      }
    }

    this.world.update(
      clampedDt,
      { position: renderState.position, headingRad: renderState.headingRad },
      {
        hoodWorldPos: [_hoodWorld.x, _hoodWorld.y, _hoodWorld.z],
        engineHealth: this.health.engineHealth,
        skidMarks: this.skidMarksBuf.length > 0 ? this.skidMarksBuf : undefined,
      },
    );

    this.updateCamera(clampedDt, renderState);

    this.snapshotTimer += clampedDt;
    if (this.snapshotDirty || this.snapshotTimer >= SNAPSHOT_INTERVAL) {
      this.snapshotTimer = 0;
      this.snapshotDirty = false;
      return this.buildSnapshot();
    }
    return null;
  }

  getSnapshot(): DriveSnapshot {
    return this.buildSnapshot();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.canvas.removeEventListener('pointerdown', this.handlePointerDown);
    this.canvas.removeEventListener('pointermove', this.handlePointerMove);
    this.canvas.removeEventListener('pointerup', this.handlePointerUp);
    this.canvas.removeEventListener('pointercancel', this.handlePointerUp);
    this.canvas.removeEventListener('wheel', this.handleWheel);
    this.rig.setDriveShadowMode(false);
    this.input.dispose();
    this.damageSim.dispose();
    this.sim.dispose();
    this.world.dispose();
  }

  // ------------------------------------------------------------------ internals

  private syncRigFromState(state: VehiclePhysicsState): void {
    this.rig.setDrivePose(state.position, state.quaternion);
    const wheels = state.wheels;
    for (let i = 0; i < 4; i++) {
      const src = wheels[i];
      const dst = this.wheelStatesBuf[i];
      dst.corner = src.corner;
      dst.suspensionY = src.suspensionOffset;
      dst.steerRad = src.steerAngleRad;
      dst.spinRad = src.spinAngleRad;
      dst.wobbleRad = src.wobbleRad;
    }
    this.rig.setWheelDriveState(this.wheelStatesBuf);
  }

  private snapCameraToState(state: VehiclePhysicsState): void {
    this.camInitialized = false;
    this.state = state;
    this.updateCamera(0.016, state);
  }

  private updateCamera(dt: number, state: VehiclePhysicsState): void {
    _carPos.set(state.position[0], state.position[1], state.position[2]);
    _carQuat.set(state.quaternion[0], state.quaternion[1], state.quaternion[2], state.quaternion[3]);

    // Car local +Z is forward, +Y is up, +X is left.
    _forward.set(0, 0, 1).applyQuaternion(_carQuat).normalize();
    _up.set(0, 1, 0).applyQuaternion(_carQuat).normalize();
    _right.set(-1, 0, 0).applyQuaternion(_carQuat).normalize();

    const carH = Math.max(1.15, this.rig.size.y);
    const carL = Math.max(3.8, this.rig.size.z);
    const speedRatio = clamp(state.speedKmh / 240, 0, 1);

    let targetFov = 56;
    let posStiffness = 8.5;
    let targetStiffness = 13;

    if (this.cameraView === 'chase' || this.cameraView === 'chase-far') {
      const far = this.cameraView === 'chase-far';
      const dist = (far ? carL * 1.48 + 1.9 : carL * 1.12 + 1.25) + speedRatio * (far ? 1.1 : 0.75);
      const height = far ? carH * 1.4 + 1.2 : carH * 1.08 + 0.78;

      // Flatten forward vector slightly so steep ramps don't shove the chase camera underground.
      const flatFwdX = _forward.x;
      const flatFwdZ = _forward.z;
      const flatLen = Math.hypot(flatFwdX, flatFwdZ) || 1;
      const fx = flatFwdX / flatLen;
      const fz = flatFwdZ / flatLen;

      _desiredCamPos.set(_carPos.x - fx * dist, _carPos.y + height, _carPos.z - fz * dist);
      const groundAtCam = this.world.sampleGroundHeight(_desiredCamPos.x, _desiredCamPos.z);
      _desiredCamPos.y = Math.max(_desiredCamPos.y, groundAtCam + 0.85);

      _desiredLookAt.set(_carPos.x + fx * (carL * 0.45), _carPos.y + carH * 0.62, _carPos.z + fz * (carL * 0.45));
      targetFov = lerp(far ? 56 : 54, far ? 72 : 68, speedRatio);
      posStiffness = far ? 6.5 : 8.5;
      targetStiffness = 14;
    } else if (this.cameraView === 'hood') {
      _desiredCamPos
        .set(0, carH * 0.86, carL * 0.27)
        .applyQuaternion(_carQuat)
        .add(_carPos);
      _desiredLookAt
        .set(0, carH * 0.66, carL * 4.5)
        .applyQuaternion(_carQuat)
        .add(_carPos);
      targetFov = lerp(63, 74, speedRatio);
      posStiffness = 60;
      targetStiffness = 60;
    } else if (this.cameraView === 'bumper') {
      _desiredCamPos
        .set(0, Math.max(0.46, carH * 0.36), carL * 0.52)
        .applyQuaternion(_carQuat)
        .add(_carPos);
      _desiredLookAt
        .set(0, Math.max(0.42, carH * 0.35), carL * 5.0)
        .applyQuaternion(_carQuat)
        .add(_carPos);
      targetFov = lerp(68, 79, speedRatio);
      posStiffness = 60;
      targetStiffness = 60;
    } else {
      // Orbit around the moving car
      const horiz = Math.cos(this.orbitPitch) * this.orbitDistance;
      const vert = Math.sin(this.orbitPitch) * this.orbitDistance;
      const yaw = state.headingRad + Math.PI + this.orbitYaw;
      _desiredCamPos.set(_carPos.x + Math.sin(yaw) * horiz, _carPos.y + carH * 0.55 + vert, _carPos.z + Math.cos(yaw) * horiz);
      const groundAtCam = this.world.sampleGroundHeight(_desiredCamPos.x, _desiredCamPos.z);
      _desiredCamPos.y = Math.max(_desiredCamPos.y, groundAtCam + 0.55);
      _desiredLookAt.set(_carPos.x, _carPos.y + carH * 0.52, _carPos.z);
      targetFov = 54;
      posStiffness = 14;
      targetStiffness = 18;
    }

    if (!this.camInitialized || posStiffness >= 50) {
      this.camPos.copy(_desiredCamPos);
      this.camTarget.copy(_desiredLookAt);
      this.camInitialized = true;
    } else {
      const kPos = 1 - Math.exp(-posStiffness * dt);
      const kTarget = 1 - Math.exp(-targetStiffness * dt);
      this.camPos.lerp(_desiredCamPos, kPos);
      this.camTarget.lerp(_desiredLookAt, kTarget);
    }

    // Apply decaying crash camera shake.
    if (this.cameraShake > 0.002) {
      const amp = this.cameraShake * this.cameraShake * 0.32;
      _shakeVec.set(
        Math.sin(this.elapsed * 57) * amp,
        Math.cos(this.elapsed * 73) * amp * 0.75,
        Math.sin(this.elapsed * 43 + 1.2) * amp * 0.5,
      );
      this.camera.position.copy(this.camPos).add(_shakeVec);
      this.cameraShake = Math.max(0, this.cameraShake - dt * 2.4);
    } else {
      this.cameraShake = 0;
      this.camera.position.copy(this.camPos);
    }

    this.camera.lookAt(this.camTarget);
    if (Math.abs(this.camera.fov - targetFov) > 0.05) {
      this.camera.fov = damp(this.camera.fov, targetFov, 7, dt);
      this.camera.updateProjectionMatrix();
    }
  }

  private buildSnapshot(): DriveSnapshot {
    return {
      speedKmh: this.state.speedKmh,
      speedMph: this.state.speedMph,
      rpm: this.state.rpm,
      maxRpm: this.state.maxRpm,
      gear: this.state.gear,
      throttle: this.state.throttle,
      brake: this.state.brake,
      steer: this.state.steer,
      handbrake: this.state.handbrake,
      cameraView: this.cameraView,
      inputSource: this.inputSource,
      gamepadName: this.gamepadName,
      health: {
        chassisIntegrity: this.health.chassisIntegrity,
        engineHealth: this.health.engineHealth,
        steeringPull: this.health.steeringPull,
        wheelIntegrity: [...this.health.wheelIntegrity] as [number, number, number, number],
        headlightsIntact: this.health.headlightsIntact,
        taillightsIntact: this.health.taillightsIntact,
      },
      lastImpactG: this.lastImpactG,
      totalImpacts: this.totalImpacts,
      spawnName: this.spawnName,
      lightsOn: this.lightsOn,
      turboBoost: this.state.turboBoost,
      hornActive: this.state.horn,
    };
  }

  private readonly handlePointerDown = (event: PointerEvent): void => {
    if (this.cameraView !== 'orbit' || event.button !== 0) return;
    this.orbitDragging = true;
    this.lastPointer = { x: event.clientX, y: event.clientY };
    this.canvas.setPointerCapture(event.pointerId);
  };

  private readonly handlePointerMove = (event: PointerEvent): void => {
    if (!this.orbitDragging) return;
    const dx = event.clientX - this.lastPointer.x;
    const dy = event.clientY - this.lastPointer.y;
    this.orbitYaw -= dx * 0.006;
    this.orbitPitch = clamp(this.orbitPitch + dy * 0.005, 0.06, 1.15);
    this.lastPointer = { x: event.clientX, y: event.clientY };
  };

  private readonly handlePointerUp = (event: PointerEvent): void => {
    if (!this.orbitDragging) return;
    this.orbitDragging = false;
    if (this.canvas.hasPointerCapture(event.pointerId)) this.canvas.releasePointerCapture(event.pointerId);
  };

  private readonly handleWheel = (event: WheelEvent): void => {
    if (this.cameraView !== 'orbit') return;
    this.orbitDistance = clamp(this.orbitDistance + event.deltaY * 0.005, 3.2, 16);
  };
}
