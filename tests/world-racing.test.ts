import { describe, expect, it, vi } from 'vitest';
import type { VehicleManifest } from '../packages/vehicle-core/src/index.js';
import {
  DriveInputController,
  DrivingWorldSim,
  createVehiclePhysicsConfig,
  type DynamicWorldPropDef,
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

  it('smoothly interpolates visual poses between fixed substeps and bounds advance() against frame hitches', async () => {
    const cfg = createVehiclePhysicsConfig(testManifest);
    const sim = await DrivingWorldSim.create(cfg, flatRoadColliders);
    try {
      stepMany(sim, 30, idleInput);
      // Accelerate so the car has clear displacement per substep
      stepMany(sim, 60, { throttle: 1, brake: 0, steer: -0.4, handbrake: false });

      const beforeZ = sim.getState().position[2];
      const beforeSpin = sim.getState().wheels[0].spinAngleRad;
      sim.step(1 / 60, { throttle: 1, brake: 0, steer: -0.4, handbrake: false });

      const s0 = sim.getInterpolatedState(0);
      const sMid = sim.getInterpolatedState(0.5);
      const s1 = sim.getInterpolatedState(1);

      expect(s0.position[2]).toBeCloseTo(beforeZ, 4);
      expect(s1.position[2]).toBeGreaterThan(s0.position[2] + 0.05);
      expect(sMid.position[2]).toBeCloseTo((s0.position[2] + s1.position[2]) * 0.5, 4);
      expect(sMid.wheels[0].spinAngleRad).toBeCloseTo(
        (beforeSpin + s1.wheels[0].spinAngleRad) * 0.5,
        4,
      );

      // Quaternion stays unit-length under slerp
      const qLen = Math.hypot(...sMid.quaternion);
      expect(qLen).toBeCloseTo(1, 5);

      // advance() with huge 2.0s hitch must clamp dt & bound substeps (no spiral of death)
      const adv = sim.advance(2.0, { throttle: 1, brake: 0, steer: 0, handbrake: false }, 1 / 60, 3);
      expect(adv.substeps).toBeLessThanOrEqual(3);
      expect(adv.substeps).toBeGreaterThanOrEqual(1);
      expect(adv.alpha).toBeGreaterThanOrEqual(0);
      expect(adv.alpha).toBeLessThanOrEqual(1);

      // resetPose snaps prevPose & currPose together so alpha=0 has zero teleport smear
      sim.resetPose([50, 0.1, -20], 0);
      expect(sim.getInterpolatedState(0).position[0]).toBeCloseTo(50, 2);
      expect(sim.getInterpolatedState(0.5).position[0]).toBeCloseTo(50, 2);
    } finally {
      sim.dispose();
    }
  });

  it('exposes audio-ready telemetry: turboBoost, shiftEvent, slipRatio, wheelLoad, surface, scrapeIntensity, and horn', async () => {
    const colliders: WorldColliderDef[] = [
      ...flatRoadColliders,
      {
        type: 'box',
        id: 'guardrail-east',
        tag: 'guardrail',
        surface: 'metal',
        position: [-1.12, 0.8, 30],
        halfExtents: [0.25, 0.8, 40],
      },
    ];
    const cfg = createVehiclePhysicsConfig(testManifest, { transmission: 'manual' });
    const sim = await DrivingWorldSim.create(cfg, colliders);
    try {
      stepMany(sim, 30, idleInput);

      // Full throttle builds turboBoost and exposes idle/redline RPM + wheelLoad + surface
      const accel = stepMany(sim, 90, { throttle: 1, brake: 0, steer: 0, handbrake: false, horn: true });
      expect(accel.state.idleRpm).toBe(cfg.idleRpm);
      expect(accel.state.redlineRpm).toBe(cfg.maxRpm);
      expect(accel.state.turboBoost).toBeGreaterThan(0.35);
      expect(accel.state.wheelLoad).toBeGreaterThan(0.1);
      expect(accel.state.surface).toBe('asphalt');
      expect(accel.state.horn).toBe(true);

      // Edge-triggered manual shift events ('up' then null then 'down')
      const up = sim.step(1 / 60, { throttle: 1, brake: 0, steer: 0, handbrake: false, shift: 1 });
      expect(up.state.shiftEvent).toBe('up');
      const hold = sim.step(1 / 60, { throttle: 1, brake: 0, steer: 0, handbrake: false });
      expect(hold.state.shiftEvent).toBeNull();
      const down = sim.step(1 / 60, { throttle: 0, brake: 0, steer: 0, handbrake: false, shift: -1 });
      expect(down.state.shiftEvent).toBe('down');

      // Handbrake drift spikes top-level slipRatio
      const drift = stepMany(sim, 8, { throttle: 0.4, brake: 0, steer: -0.7, handbrake: true });
      expect(drift.state.slipRatio).toBeGreaterThan(0.7);

      // Sliding along a guardrail wall produces continuous non-zero scrapeIntensity
      sim.resetPose([-0.05, 0.08, 0], 0);
      stepMany(sim, 15, idleInput);
      let maxScrape = 0;
      for (let i = 0; i < 120; i++) {
        const res = sim.step(1 / 60, { throttle: 0.9, brake: 0, steer: 0.35, handbrake: false });
        if (res.state.scrapeIntensity > maxScrape) maxScrape = res.state.scrapeIntensity;
      }
      expect(maxScrape).toBeGreaterThan(0.1);
    } finally {
      sim.dispose();
    }
  });

  it('delivers visceral low-bounce crashes, off-center corner spin torque, hard-landing impacts, and collapsed corner suspension', async () => {
    const colliders: WorldColliderDef[] = [
      ...flatRoadColliders,
      {
        type: 'box',
        id: 'offset-pillar',
        tag: 'wall',
        surface: 'concrete',
        // Offset to car's front-left (+X) so only the left nose catches it!
        position: [0.85, 1.5, 22],
        halfExtents: [0.65, 1.5, 0.8],
      },
    ];
    const cfg = createVehiclePhysicsConfig(testManifest);
    const sim = await DrivingWorldSim.create(cfg, colliders);
    try {
      stepMany(sim, 20, idleInput);
      let impactStepState = null;
      let preImpactSpeed = 0;
      for (let i = 0; i < 180; i++) {
        const prev = sim.getState();
        const res = sim.step(1 / 60, { throttle: 1, brake: 0, steer: 0, handbrake: false });
        if (res.impacts.length > 0) {
          preImpactSpeed = prev.forwardSpeedMs;
          impactStepState = res.state;
          break;
        }
      }
      expect(impactStepState).not.toBeNull();
      // Plastic energy absorption: car must NOT bounce backward like a rubber brick!
      expect(impactStepState!.forwardSpeedMs).toBeGreaterThan(-preImpactSpeed * 0.25);
      // Off-center front-left hit must induce clear angular spin/pitch velocity
      const angMag = Math.hypot(...impactStepState!.angularVelocity);
      expect(angMag).toBeGreaterThan(0.35);

      // Hard landing from a high drop emits a 'landing' ImpactEvent
      sim.resetPose([0, 6.0, 0], 0);
      let landingImpact = null;
      for (let i = 0; i < 120; i++) {
        const res = sim.step(1 / 60, idleInput);
        const found = res.impacts.find((imp) => imp.colliderTag === 'landing');
        if (found) {
          landingImpact = found;
          break;
        }
      }
      expect(landingImpact).not.toBeNull();
      expect(landingImpact!.event.localNormal[1]).toBeGreaterThan(0.8);
      expect(landingImpact!.event.relativeSpeed).toBeGreaterThan(6.5);

      // Structural wheel damage bends camber/toe and collapses damaged corner ride height
      sim.resetPose([0, 0.1, 0], 0);
      const healthySettled = stepMany(sim, 50, idleInput).state;
      sim.setMechanicalHealth({
        chassisIntegrity: 0.5,
        engineHealth: 0.8,
        steeringPull: 0.2,
        wheelIntegrity: [0.15, 1, 1, 1],
        headlightsIntact: true,
        taillightsIntact: true,
        wheelDamage: [
          { integrity: 0.15, camberRad: -0.22, toeRad: 0.12, wobbleRad: 0.14, collapsed: 0.9 },
          { integrity: 1, camberRad: 0, toeRad: 0, wobbleRad: 0, collapsed: 0 },
          { integrity: 1, camberRad: 0, toeRad: 0, wobbleRad: 0, collapsed: 0 },
          { integrity: 1, camberRad: 0, toeRad: 0, wobbleRad: 0, collapsed: 0 },
        ],
      });
      const collapsedSettled = stepMany(sim, 50, idleInput).state;
      expect(collapsedSettled.wheels[0].camberDamageRad).toBeCloseTo(-0.22, 3);
      expect(collapsedSettled.wheels[0].toeDamageRad).toBeCloseTo(0.12, 3);
      // Collapsed FL spring shortens its suspension length compared to healthy baseline
      expect(collapsedSettled.wheels[0].suspensionLength).toBeLessThan(
        healthySettled.wheels[0].suspensionLength - 0.04,
      );
    } finally {
      sim.dispose();
    }
  });

  it('simulates knockable dynamic world props (barrels, crates, barriers), emits prop impacts, and resets cleanly', async () => {
    const props: DynamicWorldPropDef[] = [
      {
        id: 'barrel-1',
        kind: 'barrel',
        shape: 'cylinder',
        halfExtents: [0.35, 0.5, 0.35],
        position: [0, 0.5, 14],
        mass: 45,
      },
      {
        id: 'crate-1',
        kind: 'crate',
        shape: 'box',
        halfExtents: [0.45, 0.45, 0.45],
        position: [0.8, 0.45, 15.5],
        rotationY: 0.25,
        mass: 30,
      },
      {
        id: 'barrier-far',
        kind: 'barrier',
        shape: 'box',
        halfExtents: [1.0, 0.5, 0.35],
        position: [40, 0.5, 40],
        mass: 180,
      },
    ];

    const cfg = createVehiclePhysicsConfig(testManifest);
    const sim = await DrivingWorldSim.create(cfg, flatRoadColliders, props);
    try {
      // Initially asleep at spawn
      const t0 = sim.getDynamicPropTransforms();
      expect(t0).toHaveLength(3);
      expect(t0[0].sleeping).toBe(true);
      expect(t0[0].position[2]).toBeCloseTo(14, 2);

      // Drive into barrel-1 and crate-1
      stepMany(sim, 15, idleInput);
      let sawPropImpact = false;
      for (let i = 0; i < 120; i++) {
        const res = sim.step(1 / 60, { throttle: 1, brake: 0, steer: 0, handbrake: false });
        if (res.impacts.some((imp) => imp.isDynamicProp && imp.dynamicPropKind === 'barrel')) {
          sawPropImpact = true;
        }
      }
      expect(sawPropImpact).toBe(true);

      // Same zero-allocation array reference is updated in-place; hit barrel moved far from spawn while untouched barrier stayed asleep
      const tAfter = sim.getDynamicPropTransforms();
      expect(tAfter).toBe(t0);
      const movedDist = Math.hypot(
        tAfter[0].position[0] - 0,
        tAfter[0].position[2] - 14,
      );
      expect(movedDist).toBeGreaterThan(2.5);
      expect(tAfter[2].sleeping).toBe(true);

      // resetDynamicProps puts everything back to spawn and asleep
      sim.resetDynamicProps();
      expect(tAfter[0].sleeping).toBe(true);
      expect(tAfter[0].position[0]).toBeCloseTo(0, 3);
      expect(tAfter[0].position[2]).toBeCloseTo(14, 3);
    } finally {
      sim.dispose();
    }
  });

  it('produces responsive tire slipRatio on full-throttle launches, hard corners, hard braking, and handbrake drifts (zero when idle/airborne)', async () => {
    const cfg = createVehiclePhysicsConfig(testManifest);
    const sim = await DrivingWorldSim.create(cfg, flatRoadColliders);
    try {
      // Idle parked -> 0 slip
      const parked = stepMany(sim, 40, idleInput).state;
      expect(parked.slipRatio).toBe(0);

      // 1. Full-throttle launch off the line -> 0.38..0.78 slip
      const launch = stepMany(sim, 12, { throttle: 1, brake: 0, steer: 0, handbrake: false }).state;
      expect(launch.slipRatio).toBeGreaterThanOrEqual(0.38);
      expect(launch.slipRatio).toBeLessThanOrEqual(0.8);

      // Build speed to ~22 m/s
      stepMany(sim, 100, { throttle: 1, brake: 0, steer: 0, handbrake: false });

      // 2. Hard fast cornering -> responsive lateral/corner-load slip
      const corner = stepMany(sim, 20, { throttle: 0.5, brake: 0, steer: -1, handbrake: false }).state;
      expect(corner.slipRatio).toBeGreaterThan(0.25);

      // 3. Hard braking at speed -> 0.35..0.85 brake lockup slip
      const hardBrake = stepMany(sim, 5, { throttle: 0, brake: 0.9, steer: 0, handbrake: false }).state;
      expect(hardBrake.slipRatio).toBeGreaterThanOrEqual(0.35);
      expect(hardBrake.slipRatio).toBeLessThanOrEqual(0.9);

      // 4. Handbrake slide -> 1.0 peak slip
      const hb = stepMany(sim, 4, { throttle: 0, brake: 0, steer: 0.5, handbrake: true }).state;
      expect(hb.slipRatio).toBe(1);

      // Airborne -> 0 slip
      sim.resetPose([0, 8, 0], 0);
      const air = sim.step(1 / 60, { throttle: 1, brake: 0, steer: -1, handbrake: true }).state;
      expect(air.airborne).toBe(true);
      expect(air.slipRatio).toBe(0);
    } finally {
      sim.dispose();
    }
  });
});

describe('DriveInputController (Keyboard + W3C Gamepad)', () => {
  it('maps keyboard driving controls, horn (H), headlights (L), inspect (V), and edge-triggered actions cleanly', () => {
    const ctrl = new DriveInputController({ getGamepads: () => [] });

    ctrl.setKeyState('KeyW', true);
    ctrl.setKeyState('KeyA', true);
    ctrl.setKeyState('Space', true);
    ctrl.setKeyState('KeyH', true);
    ctrl.setKeyState('KeyL', true);
    ctrl.setKeyState('KeyV', true);
    ctrl.setKeyState('KeyR', true);
    ctrl.setKeyState('KeyC', true);
    ctrl.setKeyState('KeyE', true);

    const f1 = ctrl.poll(0.1);
    expect(f1.activeSource).toBe('keyboard');
    expect(f1.control.throttle).toBe(1);
    expect(f1.control.steer).toBeLessThan(0);
    expect(f1.control.handbrake).toBe(true);
    expect(f1.control.horn).toBe(true);
    expect(f1.control.shift).toBe(1);
    expect(f1.actions.repair).toBe(true);
    expect(f1.actions.cycleCamera).toBe(true);
    expect(f1.actions.toggleHeadlights).toBe(true);
    expect(f1.actions.toggleInspect).toBe(true);
    expect(f1.actions.reset).toBe(false);
    expect(f1.cameraOrbitX).toBe(0);
    expect(f1.cameraOrbitY).toBe(0);

    // Holding the same keys on next frame keeps horn active but does NOT re-fire edge-triggered actions
    const f2 = ctrl.poll(0.1);
    expect(f2.actions.repair).toBe(false);
    expect(f2.actions.cycleCamera).toBe(false);
    expect(f2.actions.toggleHeadlights).toBe(false);
    expect(f2.actions.toggleInspect).toBe(false);
    expect(f2.control.shift).toBe(0);
    expect(f2.control.throttle).toBe(1);
    expect(f2.control.horn).toBe(true);

    ctrl.setKeyState('KeyH', false);
    ctrl.setKeyState('KeyT', true);
    ctrl.setKeyState('Escape', true);
    const f3 = ctrl.poll(0.1);
    expect(f3.control.horn).toBe(false);
    expect(f3.actions.reset).toBe(true);
    expect(f3.actions.exitDrive).toBe(true);
  });

  it('maps W3C Gamepad axes with deadzone/curve, right-stick camera orbit, analog triggers, horn (R3), inspect (L3), and rumble', () => {
    const playEffect = vi.fn();
    let activePad: GamepadLike | null = {
      id: 'Xbox Wireless Controller (STANDARD GAMEPAD)',
      connected: true,
      axes: [0.05, 0, 0.04, -0.05], // inside deadzone (0.12)
      buttons: Array.from({ length: 16 }, () => ({ pressed: false, value: 0 })),
      vibrationActuator: { playEffect },
    };

    const ctrl = new DriveInputController({
      stickDeadzone: 0.12,
      steerExponent: 1.5,
      getGamepads: () => [activePad],
    });

    // Deadzone filters small stick drift on both left & right sticks
    const f0 = ctrl.poll(1 / 60);
    expect(f0.gamepadConnected).toBe(true);
    expect(f0.gamepadName).toContain('Xbox');
    expect(f0.control.steer).toBe(0);
    expect(f0.cameraOrbitX).toBe(0);
    expect(f0.cameraOrbitY).toBe(0);
    expect(f0.control.horn).toBe(false);

    // Analog throttle RT (7), steering right (0.6), right-stick orbit (-0.8, 0.5), handbrake A (0), Y camera (3), RB shift up (5), Back repair (8), L3 inspect (10), R3 horn (11)
    const buttons = Array.from({ length: 16 }, () => ({ pressed: false, value: 0 }));
    buttons[0] = { pressed: true, value: 1 };
    buttons[3] = { pressed: true, value: 1 };
    buttons[5] = { pressed: true, value: 1 };
    buttons[7] = { pressed: true, value: 0.75 };
    buttons[8] = { pressed: true, value: 1 };
    buttons[10] = { pressed: true, value: 1 };
    buttons[11] = { pressed: true, value: 1 };

    activePad = {
      ...activePad,
      axes: [0.6, 0, -0.8, 0.5],
      buttons,
    };

    const f1 = ctrl.poll(1 / 60);
    expect(f1.activeSource).toBe('gamepad');
    expect(f1.control.throttle).toBeGreaterThan(0.7);
    expect(f1.control.steer).toBeGreaterThan(0.35);
    expect(f1.control.steer).toBeLessThan(0.6); // non-linear curve softens mid-stick
    expect(f1.cameraOrbitX).toBeLessThan(-0.5);
    expect(f1.cameraOrbitY).toBeGreaterThan(0.25);
    expect(f1.control.handbrake).toBe(true);
    expect(f1.control.horn).toBe(true);
    expect(f1.control.shift).toBe(1);
    expect(f1.actions.cycleCamera).toBe(true);
    expect(f1.actions.repair).toBe(true);
    expect(f1.actions.toggleInspect).toBe(true);

    // Edge-triggered gamepad actions don't fire twice while held
    const f2 = ctrl.poll(1 / 60);
    expect(f2.actions.cycleCamera).toBe(false);
    expect(f2.actions.repair).toBe(false);
    expect(f2.actions.toggleInspect).toBe(false);
    expect(f2.control.shift).toBe(0);
    expect(f2.control.horn).toBe(true);

    // Rumble triggers dual-rumble effect
    ctrl.triggerRumble(0.8, 180);
    expect(playEffect).toHaveBeenCalledWith(
      'dual-rumble',
      expect.objectContaining({ duration: 180, strongMagnitude: 0.8 }),
    );
  });
});
