import * as THREE from 'three';
import { createHealthyMechanicalHealth, RealDamageSimulator, type DetachedPartEvent, type MechanicalHealth } from '@blend-garage/damage-bridge';
import type { CarBuild } from '@blend-garage/vehicle-core';
import {
  createVehiclePhysicsConfig,
  DriveInputController,
  DrivingWorldSim,
  type DriveInputFrame,
  type VehiclePhysicsState,
} from '@blend-garage/world-racing';
import { normalizeDriveSurface, type SoundEngine } from './audio';
import { clamp, damp, lerp } from './math';
import type { DriveCameraView, DriveSnapshot } from './types';
import type { VehicleRig, WheelDriveState } from './vehicle/VehicleRig';
import { OpenWorld, type SpawnName, type WorldSkidInput } from './world';

const FIXED_DT = 1 / 60;
const MAX_SUBSTEPS = 3;
const CAMERA_CYCLE_ORDER: DriveCameraView[] = ['chase', 'chase-far', 'hood', 'bumper', 'orbit'];
const SNAPSHOT_INTERVAL = 1 / 20;
const PAN_CLAMP_METERS = 3.5;
const ZOOM_MIN = 2.4;
const ZOOM_MAX = 15.0;
const AUTO_RECENTER_DELAY = 2.5;
const MAX_DETACHED_DEBRIS = 14;

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

interface DetachedDebrisBody {
  group: THREE.Group;
  position: THREE.Vector3;
  velocity: THREE.Vector3;
  angularVelocity: THREE.Vector3;
  radius: number;
  age: number;
  bounces: number;
}

const _carPos = new THREE.Vector3();
const _carQuat = new THREE.Quaternion();
const _forward = new THREE.Vector3();
const _up = new THREE.Vector3();
const _right = new THREE.Vector3();
const _camRight = new THREE.Vector3();
const _camUp = new THREE.Vector3();
const _desiredCamPos = new THREE.Vector3();
const _desiredLookAt = new THREE.Vector3();
const _worldPan = new THREE.Vector3();
const _hoodLocal = new THREE.Vector3();
const _hoodWorld = new THREE.Vector3();
const _shakeVec = new THREE.Vector3();
const _tmpVecA = new THREE.Vector3();
const _tmpVecB = new THREE.Vector3();
const _deltaQuat = new THREE.Quaternion();
const _upAxis = new THREE.Vector3(0, 1, 0);

function isSpawnName(name: string | undefined): name is SpawnName {
  return (
    name === 'start' ||
    name === 'coast' ||
    name === 'highway' ||
    name === 'canyon' ||
    name === 'desert' ||
    name === 'proving-grounds'
  );
}

function disposeDebrisGroup(group: THREE.Group): void {
  group.traverse((obj) => {
    if (obj instanceof THREE.Mesh) obj.geometry.dispose();
  });
  group.removeFromParent();
}

/**
 * Pure TypeScript Open-World driving session: owns the 2400×2400m 6-biome OpenWorld, Rapier vehicle
 * & dynamic-prop physics, visceral crash deformation + flying detached parts, keyboard/gamepad input,
 * 48 kHz physical SoundEngine + tunnel reverb, and free-orbit/pan/zoom inspection cameras.
 * Zero React imports.
 */
export class DriveSession {
  readonly camera: THREE.PerspectiveCamera;

  private readonly scene: THREE.Scene;
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
  private preInspectCamera: DriveCameraView = 'chase';
  private spawnName: string = 'start';
  private lightsOn: boolean;
  private inTunnel = false;
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

  // Flying detached car parts (ballistic tumbling debris)
  private readonly detachedDebris: DetachedDebrisBody[] = [];

  // Pre-allocated per-frame wheel & skid buffers to avoid GC pressure.
  private readonly wheelStatesBuf: WheelDriveState[] = [
    { corner: 'FL', suspensionY: 0, steerRad: 0, spinRad: 0, wobbleRad: 0, camberDamageRad: 0, toeDamageRad: 0 },
    { corner: 'FR', suspensionY: 0, steerRad: 0, spinRad: 0, wobbleRad: 0, camberDamageRad: 0, toeDamageRad: 0 },
    { corner: 'RL', suspensionY: 0, steerRad: 0, spinRad: 0, wobbleRad: 0, camberDamageRad: 0, toeDamageRad: 0 },
    { corner: 'RR', suspensionY: 0, steerRad: 0, spinRad: 0, wobbleRad: 0, camberDamageRad: 0, toeDamageRad: 0 },
  ];
  private readonly skidMarksBuf: WorldSkidInput[] = [];

  // Smooth chase + direct orbit/pan/zoom + dedicated inspect camera state
  private readonly camPos = new THREE.Vector3();
  private readonly camTarget = new THREE.Vector3();
  private camInitialized = false;
  private cameraShake = 0;

  // User orbit/pan/zoom offsets shared across chase/chase-far, orbit, and inspect
  private chaseYawOffset = 0;
  private chasePitchOffset = 0;
  private chaseZoomDist: number;
  private orbitYaw = Math.PI * 0.2;
  private orbitPitch = 0.25;
  private orbitDistance: number;
  private readonly panOffset = new THREE.Vector2(0, 0); // camera-local X/Y meters, clamped ±PAN_CLAMP_METERS
  private camInteractionIdle = 10;

  // Pointer drag state (orbit vs pan)
  private dragMode: 'none' | 'orbit' | 'pan' = 'none';
  private activePointerId = -1;
  private lastPointer = { x: 0, y: 0 };

  private constructor(
    options: DriveSessionOptions,
    world: OpenWorld,
    sim: DrivingWorldSim,
    damageSim: RealDamageSimulator,
    input: DriveInputController,
    initialState: VehiclePhysicsState,
  ) {
    this.scene = options.scene;
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

    // Far plane = 3200m to cleanly enclose the 2250m California sky dome across the 2400×2400m map.
    this.camera = new THREE.PerspectiveCamera(56, Math.max(1, options.width) / Math.max(1, options.height), 0.15, 3200);
    const carL = Math.max(3.8, this.rig.size.z);
    this.chaseZoomDist = clamp(carL * 1.12 + 1.25, 4.8, 7.6);
    this.orbitDistance = clamp(carL * 1.15, 4.6, 6.2);

    this.rig.setDriveShadowMode(true);
    this.rig.setDriveLights(this.lightsOn);
    this.syncRigFromState(initialState);
    this.world.syncDynamicProps(this.sim.getDynamicPropTransforms());
    this.snapCameraToState(initialState);

    this.sound.setCarProfile({ id: this.rig.manifest.id, name: this.rig.manifest.name });
    this.sound.setMode('drive');
    this.sound.playIgnition();

    this.canvas.addEventListener('pointerdown', this.handlePointerDown);
    this.canvas.addEventListener('pointermove', this.handlePointerMove);
    this.canvas.addEventListener('pointerup', this.handlePointerUp);
    this.canvas.addEventListener('pointercancel', this.handlePointerUp);
    this.canvas.addEventListener('wheel', this.handleWheel, { passive: true });
    this.canvas.addEventListener('contextmenu', this.handleContextMenu);
    this.canvas.addEventListener('dblclick', this.handleDoubleClick);
  }

  /** Creates and mounts the 2400×2400m Open World, Rapier physics + dynamic props, damage sim, and input. */
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

    const sim = await DrivingWorldSim.create(physicsConfig, world.getColliders(), world.getDynamicPropDefs());

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
    if (this.cameraView === 'inspect') {
      this.cameraView = this.preInspectCamera;
    } else {
      const idx = CAMERA_CYCLE_ORDER.indexOf(this.cameraView);
      this.cameraView = CAMERA_CYCLE_ORDER[(idx + 1) % CAMERA_CYCLE_ORDER.length];
    }
    this.resetCameraOffsets(false);
    this.camInitialized = false;
    this.snapshotDirty = true;
    this.sound.playCameraSwoosh();
  }

  toggleInspect(): void {
    if (this.cameraView === 'inspect') {
      this.cameraView = this.preInspectCamera;
      this.resetCameraOffsets(false);
      this.camInitialized = false;
    } else {
      this.preInspectCamera = this.cameraView;
      this.cameraView = 'inspect';
      const carL = Math.max(3.8, this.rig.size.z);
      this.orbitYaw = 0.62;
      this.orbitPitch = 0.24;
      this.orbitDistance = clamp(carL * 1.06, 4.4, 5.4);
      this.panOffset.set(0, 0);
      this.camInitialized = false;
    }
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
    this.clearDetachedDebris();
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

    if (isSpawnName(spawnName)) {
      this.spawnName = spawnName;
      // Reset scatterable crash-arena barrels/crates/barriers when warping to Crash Arena.
      if (spawnName === 'proving-grounds') {
        this.sim.resetDynamicProps();
        this.world.syncDynamicProps(this.sim.getDynamicPropTransforms());
      }
    }

    this.state = this.sim.resetPose([pose.position[0], pose.position[1] + 0.14, pose.position[2]], pose.headingRad);
    this.accumulator = 0;
    this.cameraShake = 0;
    this.resetCameraOffsets(false);
    this.world.clearFx();
    this.syncRigFromState(this.state);
    this.snapCameraToState(this.state);
    this.sound.playReset();
    this.snapshotDirty = true;
  }

  /**
   * Advances physics, dynamic props, crash deformation, flying detached parts, car rig (with
   * smooth fixed-step pose interpolation), world FX, procedural audio, and driving/inspect cameras.
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
    if (frame.actions.toggleInspect) {
      this.toggleInspect();
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

    // Apply gamepad right-stick orbit input smoothly across chase, chase-far, orbit, and inspect.
    if (Math.abs(frame.cameraOrbitX) > 0.01 || Math.abs(frame.cameraOrbitY) > 0.01) {
      const yawSpeed = 2.15;
      const pitchSpeed = 1.45;
      if (this.cameraView === 'orbit' || this.cameraView === 'inspect') {
        this.orbitYaw -= frame.cameraOrbitX * yawSpeed * clampedDt;
        this.orbitPitch = clamp(this.orbitPitch + frame.cameraOrbitY * pitchSpeed * clampedDt, 0.04, 1.32);
      } else if (this.cameraView === 'chase' || this.cameraView === 'chase-far') {
        this.chaseYawOffset -= frame.cameraOrbitX * yawSpeed * clampedDt;
        this.chasePitchOffset = clamp(this.chasePitchOffset + frame.cameraOrbitY * pitchSpeed * clampedDt, -0.22, 1.05);
      }
      this.camInteractionIdle = 0;
    }

    const prevGear = this.state.gear;
    const prevHandbrake = this.state.handbrake;
    const prevHorn = this.state.horn;
    const prevInTunnel = this.inTunnel;

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
        for (let i = 0; i < stepResult.impacts.length; i++) {
          const impact = stepResult.impacts[i];
          const isCone = impact.isDynamicProp && impact.dynamicPropKind === 'cone';

          if (isCone) {
            // Featherweight plastic cones trigger fun sound + sparks + subtle bump without crushing steel panels.
            this.sound.playImpact({
              gForce: Math.max(2.5, impact.gForce * 0.45),
              speedMps: impact.event.relativeSpeed,
              glassBreak: false,
              panelDetached: false,
              metallic: false,
            });
            this.world.emitCrashSparks(impact.worldPoint, impact.worldNormal, 0.3);
            this.cameraShake = Math.min(1, this.cameraShake + 0.06);
            this.input.triggerRumble(0.16, 70);
            continue;
          }

          // Scale structural impulse proportionally on knockable dynamic props (barrels/crates/barriers).
          let damageEvent = impact.event;
          if (impact.isDynamicProp) {
            const propScale =
              impact.dynamicPropKind === 'barrier'
                ? 0.95
                : impact.dynamicPropKind === 'tire-stack'
                  ? 0.65
                  : 0.55;
            damageEvent = {
              ...impact.event,
              impulse: impact.event.impulse * propScale,
            };
          }

          const dmg = this.damageSim.applyImpact(damageEvent);
          this.rig.applyDamageResult(dmg);
          this.health = dmg.health;
          this.sim.setMechanicalHealth(dmg.health);

          const newlyDetachedParts = dmg.detachedParts ?? [];
          const newlyDetached =
            newlyDetachedParts.length > 0 ||
            (dmg.detachedImpulses !== undefined && dmg.detachedImpulses.length > 0) ||
            dmg.detachedPartIds.length > this.detachedPartsCount;
          this.detachedPartsCount = dmg.detachedPartIds.length;

          if (newlyDetachedParts.length > 0) {
            this.spawnDetachedDebris(newlyDetachedParts, this.state);
          }

          this.sound.playImpact({
            gForce: impact.gForce,
            speedMps: impact.event.relativeSpeed,
            glassBreak: !impact.isDynamicProp && impact.gForce >= 18,
            panelDetached: newlyDetached,
            metallic: impact.dynamicPropKind !== 'crate' && impact.dynamicPropKind !== 'tire-stack',
          });
          if (newlyDetached) this.sound.playPartDetach();

          const sparkIntensity = clamp(impact.gForce / 11, 0.45, 2.6);
          this.world.emitCrashSparks(impact.worldPoint, impact.worldNormal, sparkIntensity);
          this.cameraShake = Math.min(1, this.cameraShake + clamp(impact.gForce / 14, 0.18, 0.95));
          this.input.triggerRumble(clamp(impact.gForce / 13, 0.24, 1.0), clamp(Math.round(impact.gForce * 18), 95, 420));

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

    // Interpolate visual car pose & wheels between previous and current physics ticks for jitter-free motion.
    const alpha = clamp(this.accumulator / FIXED_DT, 0, 1);
    const renderState = this.sim.getInterpolatedState(alpha);

    this.syncRigFromState(renderState);
    this.rig.update(clampedDt);

    // Sync all 86 dynamic knockable world props directly from Rapier with zero allocations.
    this.world.syncDynamicProps(this.sim.getDynamicPropTransforms());

    // Advance flying detached car parts (gravity + ground bounce + tumbling).
    if (this.detachedDebris.length > 0) {
      this.updateDetachedDebris(clampedDt);
    }

    // Compute tunnel acoustic zone & biome ground surface for 48 kHz SoundEngine.
    this.inTunnel = this.world.isInsideTunnel(renderState.position);
    const biomeSurface = normalizeDriveSurface(
      this.world.getSurfaceAt(renderState.position[0], renderState.position[2]) ?? this.state.surface,
    );

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
      surface: biomeSurface,
      cameraMode: this.cameraView === 'inspect' ? 'orbit' : this.cameraView,
      airborne: this.state.airborne,
      hornActive: this.state.horn,
      scrapeIntensity: this.state.scrapeIntensity,
      engineHealth: this.health.engineHealth,
      inTunnel: this.inTunnel,
    });

    if (
      this.state.gear !== prevGear ||
      this.state.handbrake !== prevHandbrake ||
      this.state.horn !== prevHorn ||
      this.inTunnel !== prevInTunnel
    ) {
      this.snapshotDirty = true;
    }

    // Update OpenWorld sun shadows, ocean water, engine smoke, and tire skidmarks.
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
        const slipping =
          w.slipRatio > 0.34 || (this.state.handbrake && speedMs > 3.5 && (w.corner === 'RL' || w.corner === 'RR'));
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
    this.canvas.removeEventListener('contextmenu', this.handleContextMenu);
    this.canvas.removeEventListener('dblclick', this.handleDoubleClick);
    this.clearDetachedDebris();
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
      dst.camberDamageRad = src.camberDamageRad;
      dst.toeDamageRad = src.toeDamageRad;
    }
    this.rig.setWheelDriveState(this.wheelStatesBuf);
  }

  private spawnDetachedDebris(events: readonly DetachedPartEvent[], state: VehiclePhysicsState): void {
    _carPos.set(state.position[0], state.position[1], state.position[2]);
    _carQuat.set(state.quaternion[0], state.quaternion[1], state.quaternion[2], state.quaternion[3]);

    for (let i = 0; i < events.length; i++) {
      const ev = events[i];
      const spawned = this.rig.createDetachedDebrisGroup(ev.meshIds, ev.partId);
      if (!spawned) continue;

      // Enforce cap so extreme multi-car-part crashes never pile up memory.
      while (this.detachedDebris.length >= MAX_DETACHED_DEBRIS) {
        const oldest = this.detachedDebris.shift();
        if (oldest) disposeDebrisGroup(oldest.group);
      }

      const worldPos = spawned.localPivot.clone().applyQuaternion(_carQuat).add(_carPos);
      spawned.group.position.copy(worldPos);
      spawned.group.quaternion.copy(_carQuat);
      this.scene.add(spawned.group);

      const worldImpulse = new THREE.Vector3(ev.impulse[0], ev.impulse[1], ev.impulse[2]).applyQuaternion(_carQuat);
      const velocity = new THREE.Vector3(
        state.linearVelocity[0] + worldImpulse.x,
        Math.max(1.8, state.linearVelocity[1] + worldImpulse.y + 1.6),
        state.linearVelocity[2] + worldImpulse.z,
      );
      const angularVelocity = new THREE.Vector3(
        ev.angularVelocity[0],
        ev.angularVelocity[1],
        ev.angularVelocity[2],
      ).applyQuaternion(_carQuat);

      this.detachedDebris.push({
        group: spawned.group,
        position: worldPos,
        velocity,
        angularVelocity,
        radius: spawned.radius,
        age: 0,
        bounces: 0,
      });
    }
  }

  private updateDetachedDebris(dt: number): void {
    for (let i = this.detachedDebris.length - 1; i >= 0; i--) {
      const d = this.detachedDebris[i];
      d.age += dt;
      if (d.age > 35) {
        disposeDebrisGroup(d.group);
        this.detachedDebris.splice(i, 1);
        continue;
      }

      // Gravity + subtle air drag
      d.velocity.y -= 9.81 * dt;
      const airDrag = Math.exp(-0.25 * dt);
      d.velocity.x *= airDrag;
      d.velocity.z *= airDrag;

      d.position.addScaledVector(d.velocity, dt);

      const floorY = this.world.sampleGroundHeight(d.position.x, d.position.z) + Math.max(0.08, d.radius * 0.25);
      if (d.position.y < floorY) {
        d.position.y = floorY;
        const impactVy = -d.velocity.y;
        if (impactVy > 1.4) {
          d.velocity.y = impactVy * 0.34;
          d.velocity.x *= 0.76;
          d.velocity.z *= 0.76;
          d.angularVelocity.multiplyScalar(0.75);
          d.bounces += 1;
          if (impactVy > 3.2 && d.bounces <= 3) {
            this.world.emitCrashSparks([d.position.x, floorY + 0.04, d.position.z], [0, 1, 0], clamp(impactVy / 8, 0.3, 0.9));
          }
        } else {
          d.velocity.y = 0;
          const groundFric = Math.exp(-6.5 * dt);
          d.velocity.x *= groundFric;
          d.velocity.z *= groundFric;
          d.angularVelocity.multiplyScalar(Math.exp(-5.0 * dt));
        }
      }

      d.group.position.copy(d.position);
      const angSpeed = d.angularVelocity.length();
      if (angSpeed > 0.01) {
        _tmpVecA.copy(d.angularVelocity).divideScalar(angSpeed);
        _deltaQuat.setFromAxisAngle(_tmpVecA, angSpeed * dt);
        d.group.quaternion.premultiply(_deltaQuat);
      }
    }
  }

  private clearDetachedDebris(): void {
    for (let i = 0; i < this.detachedDebris.length; i++) {
      disposeDebrisGroup(this.detachedDebris[i].group);
    }
    this.detachedDebris.length = 0;
  }

  private resetCameraOffsets(resetZoom: boolean): void {
    this.chaseYawOffset = 0;
    this.chasePitchOffset = 0;
    this.panOffset.set(0, 0);
    if (resetZoom) {
      const carL = Math.max(3.8, this.rig.size.z);
      this.chaseZoomDist = clamp(carL * 1.12 + 1.25, 4.8, 7.6);
      this.orbitDistance = clamp(carL * 1.06, 4.4, 5.4);
      this.orbitYaw = 0.62;
      this.orbitPitch = 0.24;
    }
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
    const speedMs = Math.abs(state.forwardSpeedMs);
    const speedRatio = clamp(state.speedKmh / 240, 0, 1);

    if (this.dragMode === 'none') {
      this.camInteractionIdle += dt;
    } else {
      this.camInteractionIdle = 0;
    }

    // Smart auto-recenter in chase / chase-far:
    // NEVER recenter while parked/slow (< 2.2 m/s) so players can freely inspect crash damage!
    // Gently recenter yaw/pitch/pan only after 2.5s of driving (> 2.5 m/s) without camera input.
    if (
      (this.cameraView === 'chase' || this.cameraView === 'chase-far') &&
      this.dragMode === 'none' &&
      speedMs > 2.5 &&
      this.camInteractionIdle > AUTO_RECENTER_DELAY
    ) {
      this.chaseYawOffset = damp(this.chaseYawOffset, 0, 2.2, dt);
      this.chasePitchOffset = damp(this.chasePitchOffset, 0, 2.2, dt);
      this.panOffset.x = damp(this.panOffset.x, 0, 2.6, dt);
      this.panOffset.y = damp(this.panOffset.y, 0, 2.6, dt);
      if (Math.abs(this.chaseYawOffset) < 0.002) this.chaseYawOffset = 0;
      if (Math.abs(this.chasePitchOffset) < 0.002) this.chasePitchOffset = 0;
      if (Math.abs(this.panOffset.x) < 0.003) this.panOffset.x = 0;
      if (Math.abs(this.panOffset.y) < 0.003) this.panOffset.y = 0;
    }

    let targetFov = 56;
    let posStiffness = 8.5;
    let targetStiffness = 13;

    if (this.cameraView === 'chase' || this.cameraView === 'chase-far') {
      const far = this.cameraView === 'chase-far';
      const baseDist = far ? clamp(this.chaseZoomDist * 1.28, ZOOM_MIN, ZOOM_MAX) : this.chaseZoomDist;
      const dist = baseDist + speedRatio * (far ? 1.1 : 0.75);
      const basePitch = far ? 0.25 : 0.21;
      const pitch = clamp(basePitch + this.chasePitchOffset, 0.03, 1.28);

      const flatLen = Math.hypot(_forward.x, _forward.z) || 1;
      const baseHeading = Math.atan2(_forward.x / flatLen, _forward.z / flatLen);
      const camAzimuth = baseHeading + Math.PI + this.chaseYawOffset;

      const horiz = Math.cos(pitch) * dist;
      const vert = Math.sin(pitch) * dist;

      // Focus point starts slightly ahead of car center when driving straight, centered when orbiting/panning.
      const userMoved = Math.abs(this.chaseYawOffset) > 0.04 || this.panOffset.lengthSq() > 0.001;
      const lead = userMoved ? 0 : carL * 0.35;
      _desiredLookAt.set(
        _carPos.x + (_forward.x / flatLen) * lead,
        _carPos.y + carH * 0.56,
        _carPos.z + (_forward.z / flatLen) * lead,
      );

      // Compute camera-local right & up axes for pan offset.
      _tmpVecB.set(Math.sin(camAzimuth) * horiz, vert, Math.cos(camAzimuth) * horiz);
      _camRight.crossVectors(_upAxis, _tmpVecB).normalize();
      _camUp.crossVectors(_tmpVecB, _camRight).normalize();
      _worldPan.set(0, 0, 0).addScaledVector(_camRight, this.panOffset.x).addScaledVector(_camUp, this.panOffset.y);

      _desiredLookAt.add(_worldPan);
      _desiredCamPos.copy(_desiredLookAt).add(_tmpVecB);

      const groundAtCam = this.world.sampleGroundHeight(_desiredCamPos.x, _desiredCamPos.z);
      _desiredCamPos.y = Math.max(_desiredCamPos.y, groundAtCam + 0.42);

      targetFov = lerp(far ? 56 : 54, far ? 72 : 68, speedRatio);
      const responsive = this.dragMode !== 'none' || userMoved;
      posStiffness = responsive ? 18 : far ? 6.5 : 8.5;
      targetStiffness = responsive ? 20 : 14;
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
      // Dedicated 'inspect' or 'orbit' camera: full 360° orbit + camera-local pan + scroll zoom, never auto-recenters.
      const horiz = Math.cos(this.orbitPitch) * this.orbitDistance;
      const vert = Math.sin(this.orbitPitch) * this.orbitDistance;
      const yaw = state.headingRad + Math.PI + this.orbitYaw;

      _tmpVecB.set(Math.sin(yaw) * horiz, vert, Math.cos(yaw) * horiz);
      _camRight.crossVectors(_upAxis, _tmpVecB).normalize();
      _camUp.crossVectors(_tmpVecB, _camRight).normalize();
      _worldPan.set(0, 0, 0).addScaledVector(_camRight, this.panOffset.x).addScaledVector(_camUp, this.panOffset.y);

      _desiredLookAt.set(_carPos.x, _carPos.y + carH * 0.48, _carPos.z).add(_worldPan);
      _desiredCamPos.copy(_desiredLookAt).add(_tmpVecB);
      const groundAtCam = this.world.sampleGroundHeight(_desiredCamPos.x, _desiredCamPos.z);
      _desiredCamPos.y = Math.max(_desiredCamPos.y, groundAtCam + 0.32);

      targetFov = this.cameraView === 'inspect' ? 46 : 54;
      posStiffness = 16;
      targetStiffness = 20;
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
      const amp = this.cameraShake * this.cameraShake * 0.36;
      _shakeVec.set(
        Math.sin(this.elapsed * 57) * amp,
        Math.cos(this.elapsed * 73) * amp * 0.75,
        Math.sin(this.elapsed * 43 + 1.2) * amp * 0.5,
      );
      this.camera.position.copy(this.camPos).add(_shakeVec);
      this.cameraShake = Math.max(0, this.cameraShake - dt * 2.2);
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
        wheelDamage: this.health.wheelDamage
          ? [
              { ...this.health.wheelDamage[0] },
              { ...this.health.wheelDamage[1] },
              { ...this.health.wheelDamage[2] },
              { ...this.health.wheelDamage[3] },
            ]
          : undefined,
      },
      lastImpactG: this.lastImpactG,
      totalImpacts: this.totalImpacts,
      spawnName: this.spawnName,
      lightsOn: this.lightsOn,
      turboBoost: this.state.turboBoost,
      hornActive: this.state.horn,
      inTunnel: this.inTunnel,
    };
  }

  private supportsPointerCamera(): boolean {
    return (
      this.cameraView === 'chase' ||
      this.cameraView === 'chase-far' ||
      this.cameraView === 'orbit' ||
      this.cameraView === 'inspect'
    );
  }

  private readonly handleContextMenu = (event: MouseEvent): void => {
    event.preventDefault();
  };

  private readonly handleDoubleClick = (): void => {
    if (!this.supportsPointerCamera()) return;
    this.resetCameraOffsets(true);
    this.camInteractionIdle = 0;
  };

  private readonly handlePointerDown = (event: PointerEvent): void => {
    if (!this.supportsPointerCamera()) return;
    const isPan = event.button === 2 || event.button === 1 || (event.button === 0 && event.shiftKey);
    const isOrbit = event.button === 0 && !event.shiftKey;
    if (!isPan && !isOrbit) return;
    this.dragMode = isPan ? 'pan' : 'orbit';
    this.activePointerId = event.pointerId;
    this.lastPointer = { x: event.clientX, y: event.clientY };
    this.camInteractionIdle = 0;
    this.canvas.setPointerCapture(event.pointerId);
  };

  private readonly handlePointerMove = (event: PointerEvent): void => {
    if (this.dragMode === 'none' || event.pointerId !== this.activePointerId) return;
    const dx = event.clientX - this.lastPointer.x;
    const dy = event.clientY - this.lastPointer.y;
    this.lastPointer = { x: event.clientX, y: event.clientY };
    this.camInteractionIdle = 0;

    if (this.dragMode === 'orbit') {
      if (this.cameraView === 'orbit' || this.cameraView === 'inspect') {
        this.orbitYaw -= dx * 0.0062;
        this.orbitPitch = clamp(this.orbitPitch + dy * 0.0052, 0.04, 1.32);
      } else {
        this.chaseYawOffset -= dx * 0.0062;
        this.chasePitchOffset = clamp(this.chasePitchOffset + dy * 0.0052, -0.22, 1.05);
      }
    } else {
      // Camera-local X/Y pan scaled to current zoom distance so close-up inspection feels precise.
      const dist =
        this.cameraView === 'orbit' || this.cameraView === 'inspect' ? this.orbitDistance : this.chaseZoomDist;
      const panScale = clamp(dist * 0.0014, 0.003, 0.016);
      this.panOffset.x = clamp(this.panOffset.x - dx * panScale, -PAN_CLAMP_METERS, PAN_CLAMP_METERS);
      this.panOffset.y = clamp(this.panOffset.y + dy * panScale, -PAN_CLAMP_METERS * 0.65, PAN_CLAMP_METERS);
    }
  };

  private readonly handlePointerUp = (event: PointerEvent): void => {
    if (this.dragMode === 'none' || event.pointerId !== this.activePointerId) return;
    this.dragMode = 'none';
    this.activePointerId = -1;
    if (this.canvas.hasPointerCapture(event.pointerId)) this.canvas.releasePointerCapture(event.pointerId);
  };

  private readonly handleWheel = (event: WheelEvent): void => {
    if (!this.supportsPointerCamera()) return;
    const delta = event.deltaY * 0.0045;
    if (this.cameraView === 'orbit' || this.cameraView === 'inspect') {
      this.orbitDistance = clamp(this.orbitDistance + delta, ZOOM_MIN, ZOOM_MAX);
    } else {
      this.chaseZoomDist = clamp(this.chaseZoomDist + delta, ZOOM_MIN, ZOOM_MAX);
    }
    this.camInteractionIdle = 0;
  };
}
