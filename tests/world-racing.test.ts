import { describe, expect, it, vi } from 'vitest';
import type { VehicleManifest } from '../packages/vehicle-core/src/index.js';
import {
  DriveInputController,
  DrivingWorldSim,
  createVehiclePhysicsConfig,
  type GamepadLike,
  type VehicleControlInput,
  type WorldColliderDef,
} from '../packages/world-racing/src/index.js';

const testManifest: VehicleManifest = {
  schemaVersion: 1,
  id: 'test-gt',
  name: 'Test GT',
  author: 'Blend Garage',
  sourceFile: 'test_gt.blend',
  importedAt: '2026-11-26T00:00:00.000Z',
  modelUrl: '/cars/test-gt/model.glb',
  bounds: {
    min: [-0.96, 0, -2.24],
    max: [0.96, 1.30, 2.24],
    size: [1.92, 1.30, 4.48],
    center: [0, 0.65, 0],
  },
  triangleCount: 24000,
  objectCount: 16,
  wheels: [
    { id: 'w-fl', corner: 'FL', objectName: 'wheel_FL', center: [0.82, 0.34, 1.36], radius: 0.34, width: 0.26 },
    { id: 'w-fr', corner: 'FR', objectName: 'wheel_FR', center: [-0.82, 0.34, 1.36], radius: 0.34, width: 0.26 },
    { id: 'w-rl', corner: 'RL', objectName: 'wheel_RL', center: [0.84, 0.35, -1.34], radius: 0.35, width: 0.29 },
    { id: 'w-rr', corner: 'RR', objectName: 'wheel_RR', center: [-0.84, 0.35, -1.34], radius: 0.35, width: 0.29 },
  ],
  parts: [],
  slots: [],
  materialZones: [],
  hints: [],
};

const flatRoadColliders: WorldColliderDef[] = [
  {
    type: 'box',
    id: 'flat-road',
    tag: 'road',
    surface: 'asphalt',
    position: [0, -0.5, 0],
    halfExtents: [250, 0.5, 250],
  },
];

const idleInput: VehicleControlInput = {
  throttle: 0,
  brake: 0,
  steer: 0,
  handbrake: false,
};

function stepMany(sim: DrivingWorldSim, steps: number, input: VehicleControlInput, dt = 1 / 60) {
  let last = sim.step(dt, input);
  for (let i = 1; i < steps; i++) {
    last = sim.step(dt, input);
  }
  return last;
}

describe('createVehiclePhysicsConfig', () => {
  it('builds a canonical 4-wheel config from manifest and falls back cleanly when wheels are missing', () => {
    const cfg = createVehiclePhysicsConfig({
      bounds: testManifest.bounds,
      wheels: [testManifest.wheels[0]],
    });
    expect(cfg.wheels).toHaveLength(4);
    expect(cfg.wheels.map((w) => w.corner)).toEqual(['FL', 'FR', 'RL', 'RR']);
    // +X is left (FL, RL), -X is right (FR, RR), +Z is front (FL, FR), -Z is rear (RL, RR)
    expect(cfg.wheels[0].position[0]).toBeGreaterThan(0);
    expect(cfg.wheels[0].position[2]).toBeGreaterThan(0);
    expect(cfg.wheels[1].position[0]).toBeLessThan(0);
    expect(cfg.wheels[2].position[2]).toBeLessThan(0);
    expect(cfg.wheels[3].position[0]).toBeLessThan(0);
    expect(cfg.wheels[3].position[2]).toBeLessThan(0);
  });
});

describe('DrivingWorldSim (Rapier3D vehicle physics)', () => {
  it('settles suspension cleanly onto flat asphalt near y = 0 with all 4 wheels grounded', async () => {
    const cfg = createVehiclePhysicsConfig(testManifest, { spawnPosition: [0, 0.12, 0] });
    const sim = await DrivingWorldSim.create(cfg, flatRoadColliders);
    try {
      const { state } = stepMany(sim, 90, idleInput);
      expect(state.groundedWheels).toBe(4);
      expect(state.airborne).toBe(false);
      // Car floor-origin should settle flush with asphalt y=0 within ~4 cm
      expect(Math.abs(state.position[1])).toBeLessThan(0.05);
      for (const w of state.wheels) {
        expect(w.inContact).toBe(true);
        expect(Math.abs(w.suspensionOffset)).toBeLessThan(0.06);
        expect(w.surface).toBe('asphalt');
      }
    } finally {
      sim.dispose();
    }
  });

  it('accelerates forward along +Z, upshifts automatically, and spins wheels positively', async () => {
    const cfg = createVehiclePhysicsConfig(testManifest);
    const sim = await DrivingWorldSim.create(cfg, flatRoadColliders);
    try {
      stepMany(sim, 30, idleInput);
      const { state } = stepMany(sim, 210, { throttle: 1, brake: 0, steer: 0, handbrake: false });

      expect(state.position[2]).toBeGreaterThan(35);
      expect(state.forwardSpeedMs).toBeGreaterThan(22); // > ~80 km/h in 3.5s
      expect(state.speedKmh).toBeGreaterThan(80);
      expect(state.speedMph).toBeGreaterThan(50);
      expect(state.gear).toBeGreaterThanOrEqual(2);
      expect(state.rpm).toBeGreaterThan(2000);
      for (const w of state.wheels) {
        expect(w.spinAngleRad).toBeGreaterThan(50);
      }
    } finally {
      sim.dispose();
    }
  });

  it('steers left (+X) on steer = -1 and right (-X) on steer = +1', async () => {
    const cfg = createVehiclePhysicsConfig(testManifest);
    const sim = await DrivingWorldSim.create(cfg, flatRoadColliders);
    try {
      stepMany(sim, 20, idleInput);
      const leftRes = stepMany(sim, 90, { throttle: 0.7, brake: 0, steer: -1, handbrake: false });
      expect(leftRes.state.position[0]).toBeGreaterThan(1.5);
      expect(leftRes.state.headingRad).toBeGreaterThan(0.15);
      expect(leftRes.state.wheels[0].steerAngleRad).toBeGreaterThan(0.1);
      expect(leftRes.state.wheels[1].steerAngleRad).toBeGreaterThan(0.1);

      sim.resetPose([0, 0.08, 0], 0);
      stepMany(sim, 20, idleInput);
      const rightRes = stepMany(sim, 90, { throttle: 0.7, brake: 0, steer: 1, handbrake: false });
      expect(rightRes.state.position[0]).toBeLessThan(-1.5);
      expect(rightRes.state.headingRad).toBeLessThan(-0.15);
      expect(rightRes.state.wheels[0].steerAngleRad).toBeLessThan(-0.1);
    } finally {
      sim.dispose();
    }
  });

  it('brakes to a stop, engages reverse when holding brake at standstill, and triggers rear slip on handbrake', async () => {
    const cfg = createVehiclePhysicsConfig(testManifest);
    const sim = await DrivingWorldSim.create(cfg, flatRoadColliders);
    try {
      stepMany(sim, 20, idleInput);
      const fast = stepMany(sim, 90, { throttle: 1, brake: 0, steer: 0, handbrake: false });
      expect(fast.state.forwardSpeedMs).toBeGreaterThan(12);

      // Handbrake while moving should raise rear slipRatio
      const drift = stepMany(sim, 8, { throttle: 0.3, brake: 0, steer: -0.8, handbrake: true });
      expect(drift.state.wheels[2].slipRatio).toBeGreaterThan(0.7);
      expect(drift.state.wheels[3].slipRatio).toBeGreaterThan(0.7);

      // Full braking slows down cleanly
      const braked = stepMany(sim, 110, { throttle: 0, brake: 1, steer: 0, handbrake: false });
      expect(braked.state.forwardSpeedMs).toBeLessThan(1);

      // Holding brake from standstill shifts into Reverse and backs up (-Z)
      const startZ = braked.state.position[2];
      const reversed = stepMany(sim, 80, { throttle: 0, brake: 1, steer: 0, handbrake: false });
      expect(reversed.state.gear).toBe(-1);
      expect(reversed.state.gearLabel).toBe('R');
      expect(reversed.state.forwardSpeedMs).toBeLessThan(-2);
      expect(reversed.state.position[2]).toBeLessThan(startZ - 1);
    } finally {
      sim.dispose();
    }
  });

  it('supports manual sequential shifting and mechanical health penalties (engine, steering pull, wheel wobble)', async () => {
    const cfg = createVehiclePhysicsConfig(testManifest, { transmission: 'manual' });
    const sim = await DrivingWorldSim.create(cfg, flatRoadColliders);
    try {
      stepMany(sim, 20, idleInput);
      const up = sim.step(1 / 60, { throttle: 0, brake: 0, steer: 0, handbrake: false, shift: 1 });
      expect(up.state.gear).toBe(2);
      const down = sim.step(1 / 60, { throttle: 0, brake: 0, steer: 0, handbrake: false, shift: -1 });
      expect(down.state.gear).toBe(1);

      // Healthy run vs engine-damaged run
      sim.setTransmissionMode('auto');
      const healthyRun = stepMany(sim, 90, { throttle: 1, brake: 0, steer: 0, handbrake: false });

      sim.resetPose([0, 0.08, 0], 0);
      sim.setMechanicalHealth({
        chassisIntegrity: 0.4,
        engineHealth: 0.1,
        steeringPull: 0.85,
        wheelIntegrity: [0.2, 1, 1, 1],
        headlightsIntact: false,
        taillightsIntact: true,
      });
      const damagedRun = stepMany(sim, 90, { throttle: 1, brake: 0, steer: 0, handbrake: false });

      // Damaged engine accelerates substantially slower
      expect(damagedRun.state.forwardSpeedMs).toBeLessThan(healthyRun.state.forwardSpeedMs * 0.65);
      // Positive steeringPull pulls left (+X), matching @blend-garage/damage-bridge
      expect(damagedRun.state.position[0]).toBeGreaterThan(0.4);
      // Damaged FL wheel exhibits wobble while intact FR wheel has zero wobble
      const maxWobble = Math.abs(damagedRun.state.wheels[0].wobbleRad);
      const stepWobble = Math.abs(
        sim.step(1 / 60, { throttle: 1, brake: 0, steer: 0, handbrake: false }).state.wheels[0].wobbleRad,
      );
      expect(Math.max(maxWobble, stepWobble)).toBeGreaterThan(0.001);
      expect(damagedRun.state.wheels[1].wobbleRad).toBe(0);
    } finally {
      sim.dispose();
    }
  });

  it('emits realistic rigid-body ImpactEvents matching @blend-garage/damage-bridge when crashing into a concrete barrier', async () => {
    const colliders: WorldColliderDef[] = [
      ...flatRoadColliders,
      {
        type: 'box',
        id: 'crash-wall-north',
        tag: 'wall',
        surface: 'concrete',
        position: [0, 1.5, 22],
        halfExtents: [8, 1.5, 1.0],
      },
    ];

    const cfg = createVehiclePhysicsConfig(testManifest);
    const sim = await DrivingWorldSim.create(cfg, colliders);
    try {
      stepMany(sim, 20, idleInput);
      let firstImpact = null;
      for (let i = 0; i < 180; i++) {
        const res = sim.step(1 / 60, { throttle: 1, brake: 0, steer: 0, handbrake: false });
        if (res.impacts.length > 0) {
          firstImpact = res.impacts[0];
          break;
        }
      }

      expect(firstImpact).not.toBeNull();
      expect(firstImpact!.colliderId).toBe('crash-wall-north');
      expect(firstImpact!.colliderTag).toBe('wall');
      expect(firstImpact!.gForce).toBeGreaterThan(1);

      const ev = firstImpact!.event;
      expect(ev.impulse).toBeGreaterThan(2000);
      expect(ev.relativeSpeed).toBeGreaterThan(5);
      // Front-end crash: localPoint is near the nose (+Z > 0.8), inward localNormal points toward -Z (< -0.5)
      expect(ev.localPoint[2]).toBeGreaterThan(0.8);
      expect(ev.localNormal[2]).toBeLessThan(-0.5);
      const normLen = Math.hypot(ev.localNormal[0], ev.localNormal[1], ev.localNormal[2]);
      expect(normLen).toBeCloseTo(1, 3);
    } finally {
      sim.dispose();
    }
  });

  it('supports cylinder bollards, heightfield terrain colliders, and clean resetPose', async () => {
    const nrows = 4;
    const ncols = 4;
    const heights = new Float32Array((nrows + 1) * (ncols + 1)).fill(0);
    const colliders: WorldColliderDef[] = [
      {
        type: 'heightfield',
        id: 'terrain-main',
        tag: 'terrain',
        surface: 'grass',
        position: [0, 0, 0],
        nrows,
        ncols,
        heights,
        scale: [80, 1, 80],
      },
      {
        type: 'cylinder',
        id: 'bollard-1',
        tag: 'pillar',
        surface: 'metal',
        position: [0, 1.0, 14],
        radius: 0.45,
        halfHeight: 1.0,
      },
    ];

    const cfg = createVehiclePhysicsConfig(testManifest);
    const sim = await DrivingWorldSim.create(cfg, colliders);
    try {
      const settled = stepMany(sim, 60, idleInput);
      expect(settled.state.groundedWheels).toBe(4);
      expect(settled.state.wheels[0].surface).toBe('grass');

      let hitBollard = false;
      for (let i = 0; i < 140; i++) {
        const res = sim.step(1 / 60, { throttle: 1, brake: 0, steer: 0, handbrake: false });
        if (res.impacts.some((imp) => imp.colliderId === 'bollard-1')) {
          hitBollard = true;
          break;
        }
      }
      expect(hitBollard).toBe(true);

      const resetState = sim.resetPose([12, 0.1, -8], Math.PI / 2);
      expect(resetState.position[0]).toBeCloseTo(12, 2);
      expect(resetState.position[2]).toBeCloseTo(-8, 2);
      expect(resetState.headingRad).toBeCloseTo(Math.PI / 2, 2);
      expect(resetState.speedKmh).toBeLessThan(0.1);
    } finally {
      sim.dispose();
    }
  });
});

describe('DriveInputController (Keyboard + W3C Gamepad)', () => {
  it('maps keyboard driving controls and edge-triggered actions cleanly', () => {
    const ctrl = new DriveInputController({ getGamepads: () => [] });

    ctrl.setKeyState('KeyW', true);
    ctrl.setKeyState('KeyA', true);
    ctrl.setKeyState('Space', true);
    ctrl.setKeyState('KeyR', true);
    ctrl.setKeyState('KeyC', true);
    ctrl.setKeyState('KeyE', true);

    const f1 = ctrl.poll(0.1);
    expect(f1.activeSource).toBe('keyboard');
    expect(f1.control.throttle).toBe(1);
    expect(f1.control.steer).toBeLessThan(0);
    expect(f1.control.handbrake).toBe(true);
    expect(f1.control.shift).toBe(1);
    expect(f1.actions.repair).toBe(true);
    expect(f1.actions.cycleCamera).toBe(true);
    expect(f1.actions.reset).toBe(false);

    // Holding the same keys on next frame should NOT re-fire edge-triggered actions
    const f2 = ctrl.poll(0.1);
    expect(f2.actions.repair).toBe(false);
    expect(f2.actions.cycleCamera).toBe(false);
    expect(f2.control.shift).toBe(0);
    expect(f2.control.throttle).toBe(1);

    ctrl.setKeyState('KeyT', true);
    ctrl.setKeyState('Escape', true);
    const f3 = ctrl.poll(0.1);
    expect(f3.actions.reset).toBe(true);
    expect(f3.actions.exitDrive).toBe(true);
  });

  it('maps W3C Gamepad axes with deadzone/curve, analog triggers, buttons, source tracking, and rumble', () => {
    const playEffect = vi.fn();
    let activePad: GamepadLike | null = {
      id: 'Xbox Wireless Controller (STANDARD GAMEPAD)',
      connected: true,
      axes: [0.05, 0, 0, 0], // inside deadzone (0.12)
      buttons: Array.from({ length: 16 }, () => ({ pressed: false, value: 0 })),
      vibrationActuator: { playEffect },
    };

    const ctrl = new DriveInputController({
      stickDeadzone: 0.12,
      steerExponent: 1.5,
      getGamepads: () => [activePad],
    });

    // Deadzone filters small stick drift
    const f0 = ctrl.poll(1 / 60);
    expect(f0.gamepadConnected).toBe(true);
    expect(f0.gamepadName).toContain('Xbox');
    expect(f0.control.steer).toBe(0);

    // Analog throttle RT (7), steering right (0.6), handbrake A (0), Y camera (3), RB shift up (5), Back repair (8)
    const buttons = Array.from({ length: 16 }, () => ({ pressed: false, value: 0 }));
    buttons[0] = { pressed: true, value: 1 };
    buttons[3] = { pressed: true, value: 1 };
    buttons[5] = { pressed: true, value: 1 };
    buttons[7] = { pressed: true, value: 0.75 };
    buttons[8] = { pressed: true, value: 1 };

    activePad = {
      ...activePad,
      axes: [0.6, 0, 0, 0],
      buttons,
    };

    const f1 = ctrl.poll(1 / 60);
    expect(f1.activeSource).toBe('gamepad');
    expect(f1.control.throttle).toBeGreaterThan(0.7);
    expect(f1.control.steer).toBeGreaterThan(0.35);
    expect(f1.control.steer).toBeLessThan(0.6); // non-linear curve softens mid-stick
    expect(f1.control.handbrake).toBe(true);
    expect(f1.control.shift).toBe(1);
    expect(f1.actions.cycleCamera).toBe(true);
    expect(f1.actions.repair).toBe(true);

    // Edge-triggered gamepad actions don't fire twice while held
    const f2 = ctrl.poll(1 / 60);
    expect(f2.actions.cycleCamera).toBe(false);
    expect(f2.actions.repair).toBe(false);
    expect(f2.control.shift).toBe(0);

    // Rumble triggers dual-rumble effect
    ctrl.triggerRumble(0.8, 180);
    expect(playEffect).toHaveBeenCalledWith(
      'dual-rumble',
      expect.objectContaining({ duration: 180, strongMagnitude: 0.8 }),
    );
  });
});
