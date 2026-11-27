import { performance } from 'node:perf_hooks';
import { describe, expect, it } from 'vitest';
import {
  classifyDamagePart,
  createHealthyWheelDamageState,
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

/** Generates a triangulated indexed hood panel facing +Y (from z=0.6 to z=2.2) with normals & indices. */
function createIndexedHoodMesh(partId: string, cols = 20, rows = 20): DeformableMeshPayload {
  const vCount = (cols + 1) * (rows + 1);
  const restPositions = new Float32Array(vCount * 3);
  const normals = new Float32Array(vCount * 3);
  for (let r = 0; r <= rows; r++) {
    const z = 0.6 + (r / rows) * 1.6;
    for (let c = 0; c <= cols; c++) {
      const x = -0.85 + (c / cols) * 1.7;
      const v = r * (cols + 1) + c;
      const i3 = v * 3;
      restPositions[i3] = x;
      restPositions[i3 + 1] = 0.92;
      restPositions[i3 + 2] = z;
      normals[i3] = 0;
      normals[i3 + 1] = 1;
      normals[i3 + 2] = 0;
    }
  }

  const indices = new Uint32Array(cols * rows * 6);
  let ptr = 0;
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const a = r * (cols + 1) + c;
      const b = a + 1;
      const d = a + (cols + 1);
      const e = d + 1;
      // CCW looking from +Y -> normal +Y
      indices[ptr++] = a;
      indices[ptr++] = d;
      indices[ptr++] = b;
      indices[ptr++] = b;
      indices[ptr++] = d;
      indices[ptr++] = e;
    }
  }

  return {
    partId,
    restPositions,
    positions: restPositions.slice(),
    normals,
    indices,
  };
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

describe('RealDamageSimulator — visceral accordion crumpling, normals, scuff mask & cabin safety cell', () => {
  it('produces deep front accordion crush, upward hood tent buckling, outward fender flare, and scuff mask', () => {
    const body = createBoxShellMesh('body/Paint', -0.95, 0.95, 0.1, 1.35, -2.2, 2.2, 16, 10, 28, true);
    const origNormals = body.normals!.slice();
    const sim = new RealDamageSimulator();
    sim.init({ carId: 'test-gt', massKg: 1450, meshes: [body] });

    // High-speed ~115 km/h (32 m/s) head-on impact into a concrete wall
    const res = sim.applyImpact({
      localPoint: [0, 0.65, 2.2],
      localNormal: [0, 0, -1],
      impulse: 36_000,
      relativeSpeed: 32,
    });

    expect(res.dirtyPartIds).toEqual(['body/Paint']);
    expect(res.detachedPartIds).toEqual([]);
    expect(res.meshUpdates).toBeDefined();
    expect(res.meshUpdates!.length).toBe(1);
    const update = res.meshUpdates![0];
    expect(update.partId).toBe('body/Paint');
    expect(update.mutatedCount).toBeGreaterThan(50);
    expect(update.dirtyVertexMax).toBeGreaterThanOrEqual(update.dirtyVertexMin);

    let maxNoseCrush = 0;
    let maxHoodLift = 0;
    let maxFenderFlare = 0;
    let rearMoved = false;
    let normalChanged = false;
    let maxScuff = 0;
    let rearScuff = 0;

    const vCount = body.positions.length / 3;
    for (let v = 0; v < vCount; v++) {
      const i = v * 3;
      const rx = body.restPositions[i];
      const ry = body.restPositions[i + 1];
      const rz = body.restPositions[i + 2];
      const dx = body.positions[i] - rx;
      const dy = body.positions[i + 1] - ry;
      const dz = body.positions[i + 2] - rz;
      const scuff = update.damageIntensity[v];
      if (scuff > maxScuff) maxScuff = scuff;

      // Nose vertices crushed dramatically inward (-Z)
      if (rz > 2.19 && Math.hypot(rx, ry - 0.65) < 0.25) {
        maxNoseCrush = Math.max(maxNoseCrush, -dz);
      }
      // Mid-hood upper surface buckles UPWARD (+Y) via volume conservation
      if (ry > 1.3 && rz > 0.8 && rz < 2.05) {
        maxHoodLift = Math.max(maxHoodLift, dy);
      }
      // Front side fenders flare OUTWARD (|x| increases)
      if (Math.abs(rx) > 0.9 && rz > 1.0 && rz < 2.0) {
        const outward = Math.sign(rx) * dx;
        maxFenderFlare = Math.max(maxFenderFlare, outward);
      }
      if (rz < -2.1) {
        if (dx !== 0 || dy !== 0 || dz !== 0) rearMoved = true;
        rearScuff = Math.max(rearScuff, scuff);
      }
      if (
        Math.abs(body.normals![i] - origNormals[i]) > 1e-3 ||
        Math.abs(body.normals![i + 1] - origNormals[i + 1]) > 1e-3 ||
        Math.abs(body.normals![i + 2] - origNormals[i + 2]) > 1e-3
      ) {
        normalChanged = true;
      }
    }

    // Dramatic 0.25m–0.65m accordion crumpling + unmistakable hood lift & fender flare
    expect(maxNoseCrush).toBeGreaterThan(0.35);
    expect(maxHoodLift).toBeGreaterThan(0.03);
    expect(maxFenderFlare).toBeGreaterThan(0.02);
    expect(rearMoved).toBe(false);
    expect(normalChanged).toBe(true);
    expect(maxScuff).toBeGreaterThan(0.6);
    expect(rearScuff).toBe(0);

    // Reset restores positions, normals, AND clears damageIntensity scuff mask to 0
    const resetRes = sim.reset();
    expect(resetRes.dirtyPartIds).toEqual(['body/Paint']);
    expect(body.positions).toEqual(body.restPositions);
    expect(body.normals).toEqual(origNormals);
    expect(update.damageIntensity.every((v) => v === 0)).toBe(true);
  });

  it('recomputes exact O(k) local creased triangle normals when indices are supplied', () => {
    const bodyRef = createBoxShellMesh('body/Frame', -0.95, 0.95, 0.1, 1.35, -2.2, 2.2, 4, 4, 6);
    const hood = createIndexedHoodMesh('body/Hood', 24, 24);
    const origNormals = hood.normals!.slice();

    const sim = new RealDamageSimulator();
    sim.init({ carId: 'indexed-normals', massKg: 1450, meshes: [bodyRef, hood] });

    const res = sim.applyImpact({
      localPoint: [0, 0.92, 2.15],
      localNormal: [0, 0, -1],
      impulse: 18_000,
      relativeSpeed: 22,
    });
    expect(res.dirtyPartIds).toContain('body/Hood');

    // Mutated vertices near front of hood must have unit-length tilted normals reflecting actual deformed triangles
    let mutatedNormals = 0;
    let untouchedNormals = 0;
    const vCount = hood.positions.length / 3;
    for (let v = 0; v < vCount; v++) {
      const i = v * 3;
      const nx = hood.normals![i];
      const ny = hood.normals![i + 1];
      const nz = hood.normals![i + 2];
      const len = Math.hypot(nx, ny, nz);
      expect(len).toBeCloseTo(1.0, 4);

      const changed =
        Math.abs(nx - origNormals[i]) > 0.02 ||
        Math.abs(ny - origNormals[i + 1]) > 0.02 ||
        Math.abs(nz - origNormals[i + 2]) > 0.02;
      if (changed) mutatedNormals++;
      else if (hood.restPositions[i + 2] < 0.7) untouchedNormals++;
    }

    expect(mutatedNormals).toBeGreaterThan(25);
    expect(untouchedNormals).toBeGreaterThan(10);

    sim.reset();
    expect(hood.normals).toEqual(origNormals);
    expect(hood.positions).toEqual(hood.restPositions);
  });

  it('carves elongated longitudinal scraping creases on glancing side impacts', () => {
    const body = createBoxShellMesh('body/Paint', -0.95, 0.95, 0.1, 1.35, -2.2, 2.2, 8, 8, 32, true);
    const sim = new RealDamageSimulator();
    sim.init({ carId: 'scrape-car', massKg: 1450, meshes: [body] });

    const res = sim.applyImpact({
      localPoint: [0.95, 0.65, 0.0],
      localNormal: [-1, 0, 0],
      impulse: 9_000,
      relativeSpeed: 20,
    });
    expect(res.dirtyPartIds).toContain('body/Paint');

    let minScrapedZ = Number.POSITIVE_INFINITY;
    let maxScrapedZ = Number.NEGATIVE_INFINITY;
    const vCount = body.positions.length / 3;
    for (let v = 0; v < vCount; v++) {
      const i = v * 3;
      if (body.restPositions[i] > 0.9 && body.positions[i] < body.restPositions[i] - 0.01) {
        const z = body.restPositions[i + 2];
        if (z < minScrapedZ) minScrapedZ = z;
        if (z > maxScrapedZ) maxScrapedZ = z;
      }
    }
    // Elongated side scrape spans well over 1.5m along the flank
    expect(maxScrapedZ - minScrapedZ).toBeGreaterThan(1.5);
  });

  it('enforces the rigid cabin safety cell and keeps interior vertices undeformed', () => {
    const outer = createBoxShellMesh('body/Outer', -0.95, 0.95, 0.1, 1.35, -2.2, 2.2, 12, 10, 20);
    // Interior seat vertices inside the cabin safety cell
    const interiorRest = new Float32Array([0.2, 0.65, 0.0, -0.2, 0.65, 0.0]);
    const interiorPos = interiorRest.slice();
    const interior: DeformableMeshPayload = {
      partId: 'body/Interior',
      restPositions: interiorRest,
      positions: interiorPos,
    };

    const sim = new RealDamageSimulator({ maxVertexDisplacement: 0.7 });
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
    const cap = 0.52;
    const rest = new Float32Array([0, 0.6, 2.2, 0, 0.6, -2.2, -0.95, 0.1, 0, 0.95, 1.35, 0]);
    const pos = rest.slice();
    const sim = new RealDamageSimulator({ maxVertexDisplacement: cap });
    sim.init({ carId: 'multi-hit', massKg: 1400, meshes: [{ partId: 'body_shell', restPositions: rest, positions: pos }] });

    const hit = () =>
      sim.applyImpact({
        localPoint: [0, 0.6, 2.2],
        localNormal: [0, 0, -1],
        impulse: 4500,
        relativeSpeed: 10,
      });

    hit();
    const d1 = rest[2] - pos[2];
    hit();
    const d2 = rest[2] - pos[2];
    hit();
    const d3 = rest[2] - pos[2];

    expect(d1).toBeGreaterThan(0.08);
    expect(d2).toBeGreaterThan(d1);
    expect(d3).toBeGreaterThan(d2);
    // Strain hardening: second hit adds less than first hit
    expect(d2 - d1).toBeLessThan(d1);

    // Many extreme hits stay within the cumulative displacement cap
    for (let k = 0; k < 12; k++) {
      sim.applyImpact({
        localPoint: [0, 0.6, pos[2]],
        localNormal: [0, 0, -1],
        impulse: 45_000,
        relativeSpeed: 38,
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

describe('RealDamageSimulator — detachable parts, structural wheel/axle damage & mechanical health', () => {
  it('emits DetachedPartEvent (detachedParts) with meshIds & launch impulses and keeps main body attached', () => {
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

    // New rich DetachedPartEvent[] contract
    expect(res.detachedParts).toBeDefined();
    expect(res.detachedParts!.length).toBe(1);
    const ev = res.detachedParts![0];
    expect(ev.partId).toBe('part_bumper_front');
    expect(ev.meshIds).toEqual(['part_bumper_front/Paint', 'part_bumper_front/Trim']);
    expect(Math.hypot(...ev.impulse)).toBeGreaterThan(3);
    expect(Math.hypot(...ev.angularVelocity)).toBeGreaterThan(1.5);

    // Legacy DetachedPartImpulse[] remains populated for backwards compatibility
    expect(res.detachedImpulses).toBeDefined();
    expect(res.detachedImpulses!.length).toBe(1);
    expect(res.detachedImpulses![0].partId).toBe('part_bumper_front');
    expect(res.detachedImpulses![0].origin[2]).toBeGreaterThan(1.9);

    // Subsequent impact does NOT re-emit the same detached part or mutate detached bumper
    const frozenBumper = bumperPaint.positions.slice();
    const res2 = sim.applyImpact({
      localPoint: [0, 0.35, 2.25],
      localNormal: [0, 0, -1],
      impulse: 12_000,
      relativeSpeed: 20,
    });
    expect(res2.detachedParts).toEqual([]);
    expect(res2.detachedImpulses).toEqual([]);
    expect(bumperPaint.positions).toEqual(frozenBumper);

    // Reset restores bumper & clears detached state
    const resetRes = sim.reset();
    expect(resetRes.detachedPartIds).toEqual([]);
    expect(resetRes.detachedParts).toEqual([]);
    expect(resetRes.dirtyPartIds).toContain('part_bumper_front/Paint');
    expect(resetRes.dirtyPartIds).toContain('part_bumper_front/Trim');
    expect(bumperPaint.positions).toEqual(bumperPaint.restPositions);
  });

  it('degrades engine, lamps, per-corner structural wheelDamage (camber/toe/wobble/collapse), and steering pull', () => {
    const body = createBoxShellMesh('body/Paint', -0.95, 0.95, 0.1, 1.35, -2.2, 2.2, 6, 4, 8);
    const sim = new RealDamageSimulator();
    sim.init({ carId: 'mech-car', massKg: 1450, meshes: [body] });

    // 1. Heavy front-left (+X, +Z) corner hit: engine + headlights + FL wheel camber/toe/wobble/collapse + steering pull
    const frontLeft = sim.applyImpact({
      localPoint: [0.85, 0.45, 1.65],
      localNormal: [-0.6, 0, -0.8],
      impulse: 16_000,
      relativeSpeed: 22,
    });

    expect(frontLeft.health.engineHealth).toBeLessThan(0.75);
    expect(frontLeft.health.headlightsIntact).toBe(false);
    expect(frontLeft.health.taillightsIntact).toBe(true);
    expect(frontLeft.health.wheelIntegrity[0]).toBeLessThan(0.7); // FL heavily damaged
    expect(frontLeft.health.wheelIntegrity[0]).toBeLessThan(frontLeft.health.wheelIntegrity[1]);
    expect(frontLeft.health.wheelIntegrity[2]).toBe(1); // RL untouched
    expect(frontLeft.health.wheelIntegrity[3]).toBe(1); // RR untouched
    expect(frontLeft.health.steeringPull).toBeGreaterThan(0.1);
    expect(frontLeft.health.chassisIntegrity).toBeLessThan(0.85);

    // Verify rich per-corner WheelDamageState
    const wd = frontLeft.health.wheelDamage!;
    expect(wd).toHaveLength(4);
    expect(wd[0].integrity).toBeCloseTo(frontLeft.health.wheelIntegrity[0], 6);
    expect(Math.abs(wd[0].camberRad)).toBeGreaterThan(0.05);
    expect(Math.abs(wd[0].toeRad)).toBeGreaterThan(0.04);
    expect(wd[0].wobbleRad).toBeGreaterThan(0.04);
    expect(wd[0].collapsed).toBeGreaterThan(0.05);
    expect(wd[0].collapsed).toBeLessThanOrEqual(1);
    expect(wd[2]).toEqual(createHealthyWheelDamageState());
    expect(wd[3]).toEqual(createHealthyWheelDamageState());

    // 2. Heavy rear-right (-X, -Z) hit: kills taillights + damages RR wheel structurally
    const rearRight = sim.applyImpact({
      localPoint: [-0.85, 0.45, -1.75],
      localNormal: [0.5, 0, 0.866],
      impulse: 14_000,
      relativeSpeed: 19,
    });
    expect(rearRight.health.taillightsIntact).toBe(false);
    expect(rearRight.health.wheelIntegrity[3]).toBeLessThan(0.75);
    expect(Math.abs(rearRight.health.wheelDamage![3].camberRad)).toBeGreaterThan(0.04);
    expect(rearRight.health.chassisIntegrity).toBeLessThan(frontLeft.health.chassisIntegrity);

    // 3. Reset restores all mechanical health & wheelDamage to 100% mint
    const resetRes = sim.reset();
    expect(resetRes.health).toEqual({
      chassisIntegrity: 1,
      engineHealth: 1,
      steeringPull: 0,
      wheelIntegrity: [1, 1, 1, 1],
      headlightsIntact: true,
      taillightsIntact: true,
      wheelDamage: [
        createHealthyWheelDamageState(),
        createHealthyWheelDamageState(),
        createHealthyWheelDamageState(),
        createHealthyWheelDamageState(),
      ],
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
    expect(res.detachedParts).toEqual([]);
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

describe('RealDamageSimulator — high-poly performance (260k+ vertices & mega-poly sparse normals)', () => {
  it('executes localized impacts in milliseconds on a 260,000-vertex mesh with sparse normal restore', () => {
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
    const origNormals = normals.slice();
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
    // Verify sparse normal backup (>250k verts) restored normals bit-identically
    expect(normals[0]).toBe(origNormals[0]);
    expect(normals[vertexCount * 3 - 1]).toBe(origNormals[vertexCount * 3 - 1]);

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
      expect(res.meshUpdates![0].damageIntensity.length).toBe(vertexCount);
    }

    const avgImpactMs = totalImpactMs / impacts.length;

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
    expect(mutated).toBeGreaterThan(2000);
    expect(untouched).toBeGreaterThan(100_000);

    expect(initMs).toBeLessThan(200);
    expect(avgImpactMs).toBeLessThan(35);

    const tReset0 = performance.now();
    const resetRes = sim.reset();
    const resetMs = performance.now() - tReset0;
    expect(resetRes.dirtyPartIds).toEqual(['body/HighPolyPaint']);
    expect(positions[0]).toBe(rest[0]);
    let normalMismatches = 0;
    for (let i = 0; i < normals.length; i++) {
      if (normals[i] !== origNormals[i]) normalMismatches++;
    }
    expect(normalMismatches).toBe(0);
    expect(resetMs).toBeLessThan(35);
  });
});
