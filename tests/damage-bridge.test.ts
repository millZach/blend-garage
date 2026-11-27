import { performance } from 'node:perf_hooks';
import { describe, expect, it } from 'vitest';
import {
  classifyDamagePart,
  extractLogicalPartId,
  LocalDentStubSimulator,
  NoopDamageSimulator,
  RealDamageSimulator,
  type DeformableMeshPayload,
} from '../packages/damage-bridge/src/index.js';

/** Generates a grid of vertices forming an outer car box shell (front = +Z, left = +X, up = +Y). */
function createBoxShellMesh(
  partId: string,
  minX: number,
  maxX: number,
  minY: number,
  maxY: number,
  minZ: number,
  maxZ: number,
  stepsX: number,
  stepsY: number,
  stepsZ: number,
  withNormals = false,
): DeformableMeshPayload {
  const pts: number[] = [];
  const nrms: number[] = [];

  const push = (x: number, y: number, z: number, nx: number, ny: number, nz: number) => {
    pts.push(x, y, z);
    if (withNormals) nrms.push(nx, ny, nz);
  };

  // Front (+Z) & Rear (-Z) faces
  for (let ix = 0; ix <= stepsX; ix++) {
    const x = minX + (maxX - minX) * (ix / stepsX);
    for (let iy = 0; iy <= stepsY; iy++) {
      const y = minY + (maxY - minY) * (iy / stepsY);
      push(x, y, maxZ, 0, 0, 1);
      push(x, y, minZ, 0, 0, -1);
    }
  }

  // Left (+X) & Right (-X) faces
  for (let iz = 0; iz <= stepsZ; iz++) {
    const z = minZ + (maxZ - minZ) * (iz / stepsZ);
    for (let iy = 0; iy <= stepsY; iy++) {
      const y = minY + (maxY - minY) * (iy / stepsY);
      push(maxX, y, z, 1, 0, 0);
      push(minX, y, z, -1, 0, 0);
    }
  }

  // Top (+Y) & Bottom (-Y) faces
  for (let ix = 0; ix <= stepsX; ix++) {
    const x = minX + (maxX - minX) * (ix / stepsX);
    for (let iz = 0; iz <= stepsZ; iz++) {
      const z = minZ + (maxZ - minZ) * (iz / stepsZ);
      push(x, maxY, z, 0, 1, 0);
      push(x, minY, z, 0, -1, 0);
    }
  }

  const restPositions = new Float32Array(pts);
  const positions = restPositions.slice();
  return withNormals
    ? { partId, restPositions, positions, normals: new Float32Array(nrms) }
    : { partId, restPositions, positions };
}

describe('RealDamageSimulator — part classification', () => {
  it('distinguishes non-detachable core body from bolt-on detachable parts', () => {
    expect(extractLogicalPartId('body/mat_paint_primary')).toBe('body');
    expect(extractLogicalPartId('part-spoiler/Carbon')).toBe('part-spoiler');

    expect(classifyDamagePart('body/Mirror_Chrome').detachable).toBe(false);
    expect(classifyDamagePart('body_shell').detachable).toBe(false);
    expect(classifyDamagePart('part_mirror_L/Plastic')).toMatchObject({
      logicalId: 'part_mirror_L',
      category: 'mirror',
      detachable: true,
    });
    expect(classifyDamagePart('part_bumper_front/Paint')).toMatchObject({
      logicalId: 'part_bumper_front',
      category: 'bumper',
      detachable: true,
    });
    expect(classifyDamagePart('part-spoiler/Carbon')).toMatchObject({
      logicalId: 'part-spoiler',
      category: 'spoiler',
      detachable: true,
    });
    expect(classifyDamagePart('part_hood/Paint').category).toBe('hood');
    expect(classifyDamagePart('part_door_FL/Paint').category).toBe('door');
    expect(classifyDamagePart('part_fender_FR/Paint').category).toBe('fender');
  });
});

describe('RealDamageSimulator — deformation & cabin safety cell', () => {
  it('creates smooth inward plastic dents with radial falloff, buckling, and normal updates', () => {
    const body = createBoxShellMesh('body/Paint', -0.95, 0.95, 0.1, 1.35, -2.2, 2.2, 16, 10, 24, true);
    const origNormals = body.normals!.slice();
    const sim = new RealDamageSimulator();
    sim.init({ carId: 'test-gt', massKg: 1450, meshes: [body] });

    const res = sim.applyImpact({
      localPoint: [0, 0.65, 2.2],
      localNormal: [0, 0, -1],
      impulse: 8000,
      relativeSpeed: 16,
    });

    expect(res.dirtyPartIds).toEqual(['body/Paint']);
    expect(res.detachedPartIds).toEqual([]);

    // Inspect front-center vertex vs mid-ring vs untouched rear vertex
    let centerDent = 0;
    let midRingLateral = 0;
    let rearMoved = false;
    let normalChanged = false;

    const vCount = body.positions.length / 3;
    for (let v = 0; v < vCount; v++) {
      const i = v * 3;
      const rx = body.restPositions[i];
      const ry = body.restPositions[i + 1];
      const rz = body.restPositions[i + 2];
      const dx = body.positions[i] - rx;
      const dy = body.positions[i + 1] - ry;
      const dz = body.positions[i + 2] - rz;

      if (rz > 2.19 && Math.hypot(rx, ry - 0.65) < 0.12) {
        expect(dz).toBeLessThan(-0.05); // pushed inward (-Z)
        centerDent = Math.max(centerDent, -dz);
      }
      if (rz > 2.19) {
        const d = Math.hypot(rx, ry - 0.65);
        if (d > 0.2 && d < 0.5) {
          midRingLateral = Math.max(midRingLateral, Math.hypot(dx, dy));
        }
      }
      if (rz < -2.1) {
        if (dx !== 0 || dy !== 0 || dz !== 0) rearMoved = true;
      }
      if (
        Math.abs(body.normals![i] - origNormals[i]) > 1e-4 ||
        Math.abs(body.normals![i + 1] - origNormals[i + 1]) > 1e-4 ||
        Math.abs(body.normals![i + 2] - origNormals[i + 2]) > 1e-4
      ) {
        normalChanged = true;
      }
    }

    expect(centerDent).toBeGreaterThan(0.08);
    expect(midRingLateral).toBeGreaterThan(0.001); // perpendicular sheet-metal buckling
    expect(rearMoved).toBe(false);
    expect(normalChanged).toBe(true);

    // Reset restores both positions AND normals cleanly
    const resetRes = sim.reset();
    expect(resetRes.dirtyPartIds).toEqual(['body/Paint']);
    expect(body.positions).toEqual(body.restPositions);
    expect(body.normals).toEqual(origNormals);
  });

  it('enforces the rigid cabin safety cell and keeps interior vertices undeformed', () => {
    const outer = createBoxShellMesh('body/Outer', -0.95, 0.95, 0.1, 1.35, -2.2, 2.2, 12, 10, 20);
    // Add an interior seat vertex inside the cabin safety cell
    const interiorRest = new Float32Array([0.2, 0.65, 0.0, -0.2, 0.65, 0.0]);
    const interiorPos = interiorRest.slice();
    const interior: DeformableMeshPayload = {
      partId: 'body/Interior',
      restPositions: interiorRest,
      positions: interiorPos,
    };

    const sim = new RealDamageSimulator({ maxVertexDisplacement: 0.65 });
    sim.init({ carId: 'cabin-test', massKg: 1500, meshes: [outer, interior] });
    const cabin = sim.getCabinBox();

    // Repeated massive side impacts right into the left (+X) door next to the cabin
    for (let k = 0; k < 6; k++) {
      sim.applyImpact({
        localPoint: [0.95, 0.72, 0.0],
        localNormal: [-1, 0, 0],
        impulse: 45_000,
        relativeSpeed: 35,
      });
    }

    // Interior vertices stay completely rigid
    expect(interiorPos).toEqual(interiorRest);

    // No exterior vertex may intrude strictly inside the rigid cabin safety cell
    let doorDeformed = false;
    const vCount = outer.positions.length / 3;
    for (let v = 0; v < vCount; v++) {
      const i = v * 3;
      const rx = outer.restPositions[i];
      const px = outer.positions[i];
      const py = outer.positions[i + 1];
      const pz = outer.positions[i + 2];

      if (rx > 0.9 && Math.abs(pz) < 0.3 && Math.abs(py - 0.72) < 0.3 && px < rx - 0.05) {
        doorDeformed = true;
      }

      const strictlyInsideCabin =
        px > cabin.min[0] + 1e-3 &&
        px < cabin.max[0] - 1e-3 &&
        py > cabin.min[1] + 1e-3 &&
        py < cabin.max[1] - 1e-3 &&
        pz > cabin.min[2] + 1e-3 &&
        pz < cabin.max[2] - 1e-3;
      expect(strictlyInsideCabin).toBe(false);

      // Anti-inversion: left side never crosses centerline
      if (rx > 0.1) expect(px).toBeGreaterThan(0);
    }

    expect(doorDeformed).toBe(true);
  });

  it('accumulates plastic deformation across multiple hits with strain hardening and cap', () => {
    const cap = 0.42;
    const rest = new Float32Array([0, 0.6, 2.2, 0, 0.6, -2.2, -0.95, 0.1, 0, 0.95, 1.35, 0]);
    const pos = rest.slice();
    const sim = new RealDamageSimulator({ maxVertexDisplacement: cap });
    sim.init({ carId: 'multi-hit', massKg: 1400, meshes: [{ partId: 'body_shell', restPositions: rest, positions: pos }] });

    const hit = () =>
      sim.applyImpact({
        localPoint: [0, 0.6, 2.2],
        localNormal: [0, 0, -1],
        impulse: 6000,
        relativeSpeed: 12,
      });

    hit();
    const d1 = rest[2] - pos[2];
    hit();
    const d2 = rest[2] - pos[2];
    hit();
    const d3 = rest[2] - pos[2];

    expect(d1).toBeGreaterThan(0.05);
    expect(d2).toBeGreaterThan(d1);
    expect(d3).toBeGreaterThan(d2);
    // Strain hardening: second hit adds less than first hit
    expect(d2 - d1).toBeLessThan(d1);

    // Many extreme hits stay within the cumulative displacement cap
    for (let k = 0; k < 12; k++) {
      sim.applyImpact({
        localPoint: [0, 0.6, pos[2]],
        localNormal: [0, 0, -1],
        impulse: 40_000,
        relativeSpeed: 35,
      });
    }
    const totalDisp = Math.hypot(pos[0] - rest[0], pos[1] - rest[1], pos[2] - rest[2]);
    expect(totalDisp).toBeLessThanOrEqual(cap + 1e-4);
  });

  it('ignores sub-threshold bumps and throttles rapid same-spot scrapes during step()', () => {
    const body = createBoxShellMesh('body/Paint', -0.95, 0.95, 0.1, 1.35, -2.2, 2.2, 8, 6, 12);
    const sim = new RealDamageSimulator({ minImpulse: 200, minRelativeSpeed: 1.5, cooldownSeconds: 0.06 });
    sim.init({ carId: 'cooldown-car', massKg: 1400, meshes: [body] });

    // Below threshold -> no-op
    const tap = sim.applyImpact({
      localPoint: [0, 0.6, 2.2],
      localNormal: [0, 0, -1],
      impulse: 120,
      relativeSpeed: 0.8,
    });
    expect(tap.dirtyPartIds).toEqual([]);
    expect(tap.health.chassisIntegrity).toBe(1);

    // Advance clock once so live cooldown tracking is active
    sim.step(0.016);
    const first = sim.applyImpact({
      localPoint: [0, 0.6, 2.2],
      localNormal: [0, 0, -1],
      impulse: 4000,
      relativeSpeed: 10,
    });
    expect(first.dirtyPartIds).toContain('body/Paint');
    const afterFirst = body.positions.slice();

    // 16ms later at the exact same spot with equal/lower impulse -> throttled
    sim.step(0.016);
    const spam = sim.applyImpact({
      localPoint: [0.02, 0.6, 2.18],
      localNormal: [0, 0, -1],
      impulse: 3500,
      relativeSpeed: 9,
    });
    expect(spam.dirtyPartIds).toEqual([]);
    expect(body.positions).toEqual(afterFirst);

    // After cooldown expires -> applies normally
    sim.step(0.07);
    const afterCooldown = sim.applyImpact({
      localPoint: [0, 0.6, 2.2],
      localNormal: [0, 0, -1],
      impulse: 4000,
      relativeSpeed: 10,
    });
    expect(afterCooldown.dirtyPartIds).toContain('body/Paint');
  });
});

describe('RealDamageSimulator — detachable parts & mechanical health', () => {
  it('detaches bolt-on parts with launch impulses and keeps main body attached', () => {
    const body = createBoxShellMesh('body/Paint', -0.95, 0.95, 0.15, 1.35, -2.0, 2.0, 6, 4, 8);
    const bumperPaint = createBoxShellMesh('part_bumper_front/Paint', -0.92, 0.92, 0.15, 0.6, 2.0, 2.25, 6, 3, 2);
    const bumperTrim = createBoxShellMesh('part_bumper_front/Trim', -0.85, 0.85, 0.15, 0.35, 2.1, 2.26, 4, 2, 1);

    const sim = new RealDamageSimulator();
    sim.init({ carId: 'detach-car', massKg: 1450, meshes: [body, bumperPaint, bumperTrim] });

    // Severe frontal smash detaches front bumper
    const res = sim.applyImpact({
      localPoint: [0, 0.35, 2.25],
      localNormal: [0, 0, -1],
      impulse: 12_000,
      relativeSpeed: 20,
    });

    expect(res.detachedPartIds).toContain('part_bumper_front');
    expect(res.detachedPartIds).toContain('part_bumper_front/Paint');
    expect(res.detachedPartIds).toContain('part_bumper_front/Trim');
    expect(res.detachedPartIds).not.toContain('body');
    expect(res.detachedPartIds).not.toContain('body/Paint');

    expect(res.detachedImpulses).toBeDefined();
    expect(res.detachedImpulses!.length).toBe(1);
    const imp = res.detachedImpulses![0];
    expect(imp.partId).toBe('part_bumper_front');
    expect(Math.hypot(...imp.impulse)).toBeGreaterThan(2);
    expect(Math.hypot(...imp.angularVelocity)).toBeGreaterThan(1);
    expect(imp.origin[2]).toBeGreaterThan(1.9);

    // Subsequent impact does NOT re-emit the same detachedImpulse or mutate detached bumper
    const frozenBumper = bumperPaint.positions.slice();
    const res2 = sim.applyImpact({
      localPoint: [0, 0.35, 2.25],
      localNormal: [0, 0, -1],
      impulse: 12_000,
      relativeSpeed: 20,
    });
    expect(res2.detachedImpulses).toEqual([]);
    expect(bumperPaint.positions).toEqual(frozenBumper);

    // Reset restores bumper & clears detached state
    const resetRes = sim.reset();
    expect(resetRes.detachedPartIds).toEqual([]);
    expect(resetRes.dirtyPartIds).toContain('part_bumper_front/Paint');
    expect(resetRes.dirtyPartIds).toContain('part_bumper_front/Trim');
    expect(bumperPaint.positions).toEqual(bumperPaint.restPositions);
  });

  it('degrades engine, lamps, per-corner wheel integrity, steering pull, and chassis health accurately', () => {
    const body = createBoxShellMesh('body/Paint', -0.95, 0.95, 0.1, 1.35, -2.2, 2.2, 6, 4, 8);
    const sim = new RealDamageSimulator();
    sim.init({ carId: 'mech-car', massKg: 1450, meshes: [body] });

    // 1. Heavy front-left (+X, +Z) corner hit: engine + headlights + FL wheel + positive steering pull
    const frontLeft = sim.applyImpact({
      localPoint: [0.85, 0.4, 1.9],
      localNormal: [-0.5, 0, -0.866],
      impulse: 11_000,
      relativeSpeed: 18,
    });

    expect(frontLeft.health.engineHealth).toBeLessThan(0.8);
    expect(frontLeft.health.headlightsIntact).toBe(false);
    expect(frontLeft.health.taillightsIntact).toBe(true);
    expect(frontLeft.health.wheelIntegrity[0]).toBeLessThan(0.85); // FL damaged
    expect(frontLeft.health.wheelIntegrity[0]).toBeLessThan(frontLeft.health.wheelIntegrity[1]); // FL worse than FR
    expect(frontLeft.health.wheelIntegrity[2]).toBe(1); // RL untouched
    expect(frontLeft.health.wheelIntegrity[3]).toBe(1); // RR untouched
    expect(frontLeft.health.steeringPull).toBeGreaterThan(0.05);
    expect(frontLeft.health.chassisIntegrity).toBeLessThan(0.9);

    // 2. Heavy rear-right (-X, -Z) hit: kills taillights + damages RR wheel
    const rearRight = sim.applyImpact({
      localPoint: [-0.85, 0.45, -1.95],
      localNormal: [0.4, 0, 0.916],
      impulse: 10_000,
      relativeSpeed: 16,
    });
    expect(rearRight.health.taillightsIntact).toBe(false);
    expect(rearRight.health.wheelIntegrity[3]).toBeLessThan(0.85); // RR damaged
    expect(rearRight.health.chassisIntegrity).toBeLessThan(frontLeft.health.chassisIntegrity);

    // 3. Reset restores all mechanical health to 1.0 / intact / 0 pull
    const resetRes = sim.reset();
    expect(resetRes.health).toEqual({
      chassisIntegrity: 1,
      engineHealth: 1,
      steeringPull: 0,
      wheelIntegrity: [1, 1, 1, 1],
      headlightsIntact: true,
      taillightsIntact: true,
    });

    // 4. Front-right (-X, +Z) hit produces opposite (negative) steering pull
    const frontRight = sim.applyImpact({
      localPoint: [-0.85, 0.4, 1.85],
      localNormal: [0.5, 0, -0.866],
      impulse: 11_000,
      relativeSpeed: 18,
    });
    expect(frontRight.health.wheelIntegrity[1]).toBeLessThan(frontRight.health.wheelIntegrity[0]);
    expect(frontRight.health.steeringPull).toBeLessThan(-0.05);
  });
});

describe('Backwards-compatible simulators', () => {
  it('NoopDamageSimulator leaves positions and health unchanged', () => {
    const rest = new Float32Array([0, 0.5, 2.0]);
    const live = rest.slice();
    const sim = new NoopDamageSimulator();
    sim.init({ carId: 'noop', massKg: 1400, meshes: [{ partId: 'body', restPositions: rest, positions: live }] });

    const res = sim.applyImpact({
      localPoint: [0, 0.5, 2.0],
      localNormal: [0, 0, -1],
      impulse: 20_000,
      relativeSpeed: 25,
    });
    expect(res.dirtyPartIds).toEqual([]);
    expect(res.detachedPartIds).toEqual([]);
    expect(res.health.chassisIntegrity).toBe(1);
    expect(live).toEqual(rest);
  });

  it('LocalDentStubSimulator remains exported and functional', () => {
    const rest = new Float32Array([0, 0.5, 2.0]);
    const live = rest.slice();
    const sim = new LocalDentStubSimulator();
    sim.init({ carId: 'stub', massKg: 1400, meshes: [{ partId: 'body', restPositions: rest, positions: live }] });
    const res = sim.applyImpact({
      localPoint: [0, 0.5, 2.0],
      localNormal: [0, 0, -1],
      impulse: 3500,
      relativeSpeed: 12,
    });
    expect(res.dirtyPartIds).toContain('body');
    expect(live[2]).toBeLessThan(2.0);
  });
});

describe('RealDamageSimulator — high-poly performance (250k+ vertices)', () => {
  it('executes localized impacts in milliseconds on a 260,000-vertex mesh', () => {
    // 260,000 vertices distributed across a realistic 1.9m x 1.25m x 4.4m car body surface
    const vertexCount = 260_000;
    const rest = new Float32Array(vertexCount * 3);
    const normals = new Float32Array(vertexCount * 3);
    for (let v = 0; v < vertexCount; v++) {
      const i = v * 3;
      const u = (v % 520) / 519; // 0..1 along length
      const w = Math.floor(v / 520) / 499; // 0..1 around cross-section
      const angle = w * Math.PI * 2;
      const x = Math.cos(angle) * 0.95;
      const y = 0.72 + Math.sin(angle) * 0.62;
      const z = -2.2 + u * 4.4;
      rest[i] = x;
      rest[i + 1] = y;
      rest[i + 2] = z;
      normals[i] = Math.cos(angle);
      normals[i + 1] = Math.sin(angle);
      normals[i + 2] = 0;
    }
    const positions = rest.slice();

    const sim = new RealDamageSimulator();
    const tInitStart = performance.now();
    sim.init({
      carId: 'high-poly-supercar',
      massKg: 1520,
      meshes: [{ partId: 'body/HighPolyPaint', restPositions: rest, positions, normals }],
    });
    const initMs = performance.now() - tInitStart;

    // Warm up JIT with one impact & reset
    sim.applyImpact({
      localPoint: [0, 0.65, 2.2],
      localNormal: [0, 0, -1],
      impulse: 6000,
      relativeSpeed: 14,
    });
    sim.reset();

    // Measure 5 distinct impacts around the car
    const impacts = [
      { localPoint: [0.95, 0.7, 2.0] as [number, number, number], localNormal: [-0.6, 0, -0.8] as [number, number, number] },
      { localPoint: [-0.95, 0.7, 1.9] as [number, number, number], localNormal: [0.6, 0, -0.8] as [number, number, number] },
      { localPoint: [0.95, 0.7, -2.0] as [number, number, number], localNormal: [-0.6, 0, 0.8] as [number, number, number] },
      { localPoint: [-0.95, 0.7, -1.9] as [number, number, number], localNormal: [0.6, 0, 0.8] as [number, number, number] },
      { localPoint: [0.0, 0.65, 2.2] as [number, number, number], localNormal: [0, 0, -1] as [number, number, number] },
    ];

    let totalImpactMs = 0;
    for (const imp of impacts) {
      const t0 = performance.now();
      const res = sim.applyImpact({
        localPoint: imp.localPoint,
        localNormal: imp.localNormal,
        impulse: 7500,
        relativeSpeed: 15,
      });
      totalImpactMs += performance.now() - t0;
      expect(res.dirtyPartIds).toContain('body/HighPolyPaint');
    }

    const avgImpactMs = totalImpactMs / impacts.length;

    // Verify deformation occurred and untouched middle vertices remained intact
    let mutated = 0;
    let untouched = 0;
    for (let v = 0; v < vertexCount; v++) {
      const i = v * 3;
      if (
        positions[i] !== rest[i] ||
        positions[i + 1] !== rest[i + 1] ||
        positions[i + 2] !== rest[i + 2]
      ) {
        mutated++;
      } else {
        untouched++;
      }
    }
    expect(mutated).toBeGreaterThan(1000);
    expect(untouched).toBeGreaterThan(100_000);

    // Fast spatial grid should easily beat 10ms even under CI load (typically ~0.5–3ms)
    expect(initMs).toBeLessThan(150);
    expect(avgImpactMs).toBeLessThan(10);

    // Fast reset restores all 260k vertices cleanly
    const tReset0 = performance.now();
    const resetRes = sim.reset();
    const resetMs = performance.now() - tReset0;
    expect(resetRes.dirtyPartIds).toEqual(['body/HighPolyPaint']);
    expect(positions[0]).toBe(rest[0]);
    expect(resetMs).toBeLessThan(30);
  });
});
