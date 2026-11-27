import { performance } from 'node:perf_hooks';
import { describe, expect, it } from 'vitest';
import {
  classifyDamagePart,
  createHealthyWheelDamageState,
  extractLogicalPartId,
  isGlassMeshId,
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
  it('keeps core structural panels permanently attached and allows only genuine bolt-on attachments to detach', () => {
    expect(extractLogicalPartId('body/mat_paint_primary')).toBe('body');
    expect(extractLogicalPartId('part-spoiler/Carbon')).toBe('part-spoiler');
    expect(isGlassMeshId('body/Front_Windshield_Glass')).toBe(true);
    expect(isGlassMeshId('body/Paint')).toBe(false);

    // Core structural panels NEVER detach (no hollow holes in car shell!)
    expect(classifyDamagePart('body/Mirror_Chrome').detachable).toBe(false);
    expect(classifyDamagePart('body_shell').detachable).toBe(false);
    expect(classifyDamagePart('part_hood/Paint')).toMatchObject({ category: 'hood', detachable: false });
    expect(classifyDamagePart('part_bonnet/Paint')).toMatchObject({ category: 'hood', detachable: false });
    expect(classifyDamagePart('part_door_FL/Paint')).toMatchObject({ category: 'door', detachable: false });
    expect(classifyDamagePart('part_fender_FR/Paint')).toMatchObject({ category: 'fender', detachable: false });
    expect(classifyDamagePart('part_quarter_RL/Paint')).toMatchObject({ category: 'fender', detachable: false });
    expect(classifyDamagePart('part_roof/Paint')).toMatchObject({ category: 'body', detachable: false });
    expect(classifyDamagePart('part_unknown_panel/Paint').detachable).toBe(false);

    // Genuine exterior bolt-on attachments detach on heavy localized hits (>= 40–55 kJ)
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
    expect(classifyDamagePart('part_splitter/Carbon').detachable).toBe(true);
    expect(classifyDamagePart('part_diffuser/Carbon').detachable).toBe(true);
    expect(classifyDamagePart('part_exhaust/Chrome').detachable).toBe(true);
    expect(classifyDamagePart('part_roof_rack/Black').detachable).toBe(true);
    expect(classifyDamagePart('part_tow_hook/Red').detachable).toBe(true);
    expect(classifyDamagePart('part_bumper_front/Paint').thresholdJoules).toBeGreaterThanOrEqual(40_000);
  });
});

describe('RealDamageSimulator — clean cohesive denting, wheel-well & glass protection, localized scuffs', () => {
  it('produces clean cohesive dents within 0.26–0.34m bounds and strictly localized damageIntensity', () => {
    const body = createBoxShellMesh('body/Paint', -0.95, 0.95, 0.1, 1.35, -2.2, 2.2, 16, 10, 28, true);
    const origNormals = body.normals!.slice();
    const sim = new RealDamageSimulator();
    sim.init({ carId: 'test-gt', massKg: 1450, meshes: [body] });

    // High-speed head-on impact into a concrete wall
    const res = sim.applyImpact({
      localPoint: [0, 0.65, 2.2],
      localNormal: [0, 0, -1],
      impulse: 36_000,
      relativeSpeed: 32,
    });

    expect(res.dirtyPartIds).toEqual(['body/Paint']);
    expect(res.detachedPartIds).toEqual([]);
    expect(res.meshUpdates).toBeDefined();
    const update = res.meshUpdates![0];
    expect(update.partId).toBe('body/Paint');
    expect(update.mutatedCount).toBeGreaterThan(30);

    let maxNoseCrush = 0;
    let maxTotalDisp = 0;
    let doorScuff = 0;
    let coreScuff = 0;
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
      const disp = Math.hypot(dx, dy, dz);
      if (disp > maxTotalDisp) maxTotalDisp = disp;

      const scuff = update.damageIntensity[v];
      // Strictly zero scuff wherever displacement <= 0.05m
      if (disp <= 0.05) {
        expect(scuff).toBe(0);
      }

      if (rz > 2.19 && Math.hypot(rx, ry - 0.65) < 0.25) {
        maxNoseCrush = Math.max(maxNoseCrush, -dz);
        coreScuff = Math.max(coreScuff, scuff);
      }
      // Mid-car doors stay 100% clean glossy paint (zero scuff!)
      if (Math.abs(rz) < 0.8) {
        doorScuff = Math.max(doorScuff, scuff);
      }
      if (rz < -2.1 && disp > 0) rearMoved = true;
      if (
        Math.abs(body.normals![i] - origNormals[i]) > 1e-3 ||
        Math.abs(body.normals![i + 1] - origNormals[i + 1]) > 1e-3 ||
        Math.abs(body.normals![i + 2] - origNormals[i + 2]) > 1e-3
      ) {
        normalChanged = true;
      }
    }

    // Realistic clean single-hit dent (0.08–0.24m), capped cleanly under 0.34m — never polygon soup!
    expect(maxNoseCrush).toBeGreaterThan(0.12);
    expect(maxTotalDisp).toBeLessThanOrEqual(0.35);
    expect(coreScuff).toBeGreaterThan(0.35);
    expect(doorScuff).toBe(0); // Clean undamaged doors stay 100% glossy paint!
    expect(rearMoved).toBe(false);
    expect(normalChanged).toBe(true);

    // Reset restores positions, normals, AND clears damageIntensity scuff mask to 0
    const resetRes = sim.reset();
    expect(resetRes.dirtyPartIds).toEqual(['body/Paint']);
    expect(body.positions).toEqual(body.restPositions);
    expect(body.normals).toEqual(origNormals);
    expect(update.damageIntensity.every((v) => v === 0)).toBe(true);
  });

  it('bends neighboring panels cohesively together in car space without jagged seam splits', () => {
    // Two separate meshes sharing exact boundary coordinates at (0, 0.7, 2.2) and (0.3, 0.7, 2.0)
    const meshA: DeformableMeshPayload = {
      partId: 'body/Paint',
      restPositions: new Float32Array([0, 0.7, 2.2, 0.3, 0.7, 2.0, -0.95, 0.1, -2.2, 0.95, 1.35, 2.2]),
      positions: new Float32Array([0, 0.7, 2.2, 0.3, 0.7, 2.0, -0.95, 0.1, -2.2, 0.95, 1.35, 2.2]),
    };
    const meshB: DeformableMeshPayload = {
      partId: 'body/Trim',
      restPositions: new Float32Array([0, 0.7, 2.2, 0.3, 0.7, 2.0]),
      positions: new Float32Array([0, 0.7, 2.2, 0.3, 0.7, 2.0]),
    };

    const sim = new RealDamageSimulator();
    sim.init({ carId: 'cohesive-seam', massKg: 1450, meshes: [meshA, meshB] });
    sim.applyImpact({
      localPoint: [0.1, 0.7, 2.2],
      localNormal: [0, 0, -1],
      impulse: 15_000,
      relativeSpeed: 20,
    });

    // Shared seam vertices between Paint & Trim move identically (0mm gap!)
    for (let k = 0; k < 6; k++) {
      expect(meshA.positions[k]).toBeCloseTo(meshB.positions[k], 5);
    }
  });

  it('protects wheel-well cylinders from fender intrusion and damps glass deformation', () => {
    const fender = createBoxShellMesh('body/FenderPaint', -0.95, 0.95, 0.1, 1.35, -2.2, 2.2, 10, 10, 24);
    const glassRest = new Float32Array([0.55, 0.85, 1.85, 0.65, 0.85, 1.85]);
    const glassPos = glassRest.slice();
    const glass: DeformableMeshPayload = {
      partId: 'body/Windshield_Glass',
      restPositions: glassRest,
      positions: glassPos,
    };
    const metalRest = new Float32Array([0.55, 0.85, 1.85, 0.65, 0.85, 1.85]);
    const metalPos = metalRest.slice();
    const metal: DeformableMeshPayload = {
      partId: 'body/HoodMetal',
      restPositions: metalRest,
      positions: metalPos,
    };

    const flWheel: [number, number, number] = [0.8, 0.35, 1.35];
    const sim = new RealDamageSimulator({
      wheelPositions: [flWheel, [-0.8, 0.35, 1.35], [0.8, 0.35, -1.35], [-0.8, 0.35, -1.35]],
      wheelRadii: [0.35, 0.35, 0.35, 0.35],
    });
    sim.init({ carId: 'wheel-glass', massKg: 1450, meshes: [fender, glass, metal] });

    // Heavy hit right at front-left wheel arch
    sim.applyImpact({
      localPoint: [0.95, 0.55, 1.75],
      localNormal: [-0.3, -0.2, -0.93],
      impulse: 24_000,
      relativeSpeed: 26,
    });

    // Glass deforms dramatically less than metal at the exact same location
    const glassDisp = Math.hypot(glassPos[0] - glassRest[0], glassPos[1] - glassRest[1], glassPos[2] - glassRest[2]);
    const metalDisp = Math.hypot(metalPos[0] - metalRest[0], metalPos[1] - metalRest[1], metalPos[2] - metalRest[2]);
    expect(metalDisp).toBeGreaterThan(0.05);
    expect(glassDisp).toBeLessThan(metalDisp * 0.45);

    // No exterior fender vertex starting outside the FL wheel cylinder intrudes into the spinning tire
    const minWheelClear = 0.35 + 0.08 - 1e-3;
    const vCount = fender.positions.length / 3;
    for (let v = 0; v < vCount; v++) {
      const i = v * 3;
      const rx = fender.restPositions[i];
      const ry = fender.restPositions[i + 1];
      const rz = fender.restPositions[i + 2];
      const restDistYZ = Math.hypot(ry - flWheel[1], rz - flWheel[2]);
      if (restDistYZ < minWheelClear) continue;

      const px = fender.positions[i];
      const py = fender.positions[i + 1];
      const pz = fender.positions[i + 2];
      if (Math.abs(px - flWheel[0]) < 0.25) {
        const postDistYZ = Math.hypot(py - flWheel[1], pz - flWheel[2]);
        expect(postDistYZ).toBeGreaterThanOrEqual(minWheelClear - 0.02);
      }
    }
  });

  it('recomputes exact O(k) local area-weighted triangle normals when indices are supplied', () => {
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

    let mutatedNormals = 0;
    let untouchedNormals = 0;
    const vCount = hood.positions.length / 3;
    for (let v = 0; v < vCount; v++) {
      const i = v * 3;
      const nx = hood.normals![i];
      const ny = hood.normals![i + 1];
      const nz = hood.normals![i + 2];
      expect(Math.hypot(nx, ny, nz)).toBeCloseTo(1.0, 4);

      const changed =
        Math.abs(nx - origNormals[i]) > 0.01 ||
        Math.abs(ny - origNormals[i + 1]) > 0.01 ||
        Math.abs(nz - origNormals[i + 2]) > 0.01;
      if (changed) mutatedNormals++;
      else if (hood.restPositions[i + 2] < 0.7) untouchedNormals++;
    }

    expect(mutatedNormals).toBeGreaterThan(15);
    expect(untouchedNormals).toBeGreaterThan(10);

    sim.reset();
    expect(hood.normals).toEqual(origNormals);
    expect(hood.positions).toEqual(hood.restPositions);
  });

  it('enforces the rigid cabin safety cell and keeps interior vertices undeformed', () => {
    const outer = createBoxShellMesh('body/Outer', -0.95, 0.95, 0.1, 1.35, -2.2, 2.2, 12, 10, 20);
    const interiorRest = new Float32Array([0.2, 0.65, 0.0, -0.2, 0.65, 0.0]);
    const interiorPos = interiorRest.slice();
    const interior: DeformableMeshPayload = {
      partId: 'body/Interior',
      restPositions: interiorRest,
      positions: interiorPos,
    };

    const sim = new RealDamageSimulator({ maxVertexDisplacement: 0.45 });
    sim.init({ carId: 'cabin-test', massKg: 1500, meshes: [outer, interior] });
    const cabin = sim.getCabinBox();

    for (let k = 0; k < 6; k++) {
      sim.applyImpact({
        localPoint: [0.95, 0.72, 0.0],
        localNormal: [-1, 0, 0],
        impulse: 45_000,
        relativeSpeed: 35,
      });
    }

    expect(interiorPos).toEqual(interiorRest);

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

      if (rx > 0.1) expect(px).toBeGreaterThan(0);
    }

    expect(doorDeformed).toBe(true);
  });

  it('accumulates plastic deformation across multiple hits with strain hardening and cap', () => {
    const cap = 0.32;
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

    expect(d1).toBeGreaterThan(0.05);
    expect(d2).toBeGreaterThan(d1);
    expect(d3).toBeGreaterThan(d2);
    expect(d2 - d1).toBeLessThan(d1);

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

    const tap = sim.applyImpact({
      localPoint: [0, 0.6, 2.2],
      localNormal: [0, 0, -1],
      impulse: 120,
      relativeSpeed: 0.8,
    });
    expect(tap.dirtyPartIds).toEqual([]);
    expect(tap.health.chassisIntegrity).toBe(1);

    sim.step(0.016);
    const first = sim.applyImpact({
      localPoint: [0, 0.6, 2.2],
      localNormal: [0, 0, -1],
      impulse: 4000,
      relativeSpeed: 10,
    });
    expect(first.dirtyPartIds).toContain('body/Paint');
    const afterFirst = body.positions.slice();

    sim.step(0.016);
    const spam = sim.applyImpact({
      localPoint: [0.02, 0.6, 2.18],
      localNormal: [0, 0, -1],
      impulse: 3500,
      relativeSpeed: 9,
    });
    expect(spam.dirtyPartIds).toEqual([]);
    expect(body.positions).toEqual(afterFirst);

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

describe('RealDamageSimulator — bolt-on part detachment, structural wheelDamage & mechanical health', () => {
  it('detaches bolt-on bumpers on heavy impacts while keeping hood, fenders, doors, and body permanently attached', () => {
    const body = createBoxShellMesh('body/Paint', -0.95, 0.95, 0.15, 1.35, -2.0, 2.0, 6, 4, 8);
    const hood = createBoxShellMesh('part_hood/Paint', -0.8, 0.8, 0.85, 0.98, 1.0, 2.15, 5, 2, 5);
    const fender = createBoxShellMesh('part_fender_FL/Paint', 0.82, 0.95, 0.25, 0.9, 1.0, 2.15, 2, 3, 5);
    const bumperPaint = createBoxShellMesh('part_bumper_front/Paint', -0.92, 0.92, 0.15, 0.6, 2.0, 2.25, 6, 3, 2);
    const bumperTrim = createBoxShellMesh('part_bumper_front/Trim', -0.85, 0.85, 0.15, 0.35, 2.1, 2.26, 4, 2, 1);

    const sim = new RealDamageSimulator();
    sim.init({ carId: 'detach-car', massKg: 1450, meshes: [body, hood, fender, bumperPaint, bumperTrim] });

    // Severe frontal smash (~240 kJ) detaches front bumper ONLY; hood/fender/body stay attached!
    const res = sim.applyImpact({
      localPoint: [0, 0.35, 2.25],
      localNormal: [0, 0, -1],
      impulse: 20_000,
      relativeSpeed: 24,
    });

    expect(res.detachedPartIds).toContain('part_bumper_front');
    expect(res.detachedPartIds).toContain('part_bumper_front/Paint');
    expect(res.detachedPartIds).toContain('part_bumper_front/Trim');
    expect(res.detachedPartIds).not.toContain('body');
    expect(res.detachedPartIds).not.toContain('part_hood');
    expect(res.detachedPartIds).not.toContain('part_fender_FL');

    expect(res.detachedParts).toBeDefined();
    expect(res.detachedParts!.length).toBe(1);
    const ev = res.detachedParts![0];
    expect(ev.partId).toBe('part_bumper_front');
    expect(ev.meshIds).toEqual(['part_bumper_front/Paint', 'part_bumper_front/Trim']);
    expect(Math.hypot(...ev.impulse)).toBeGreaterThan(3);
    expect(Math.hypot(...ev.angularVelocity)).toBeGreaterThan(1.5);

    // Subsequent impact does NOT re-emit the same detached part or mutate detached bumper
    const frozenBumper = bumperPaint.positions.slice();
    const res2 = sim.applyImpact({
      localPoint: [0, 0.35, 2.25],
      localNormal: [0, 0, -1],
      impulse: 20_000,
      relativeSpeed: 24,
    });
    expect(res2.detachedParts).toEqual([]);
    expect(res2.detachedImpulses).toEqual([]);
    expect(bumperPaint.positions).toEqual(frozenBumper);

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

    const frontLeft = sim.applyImpact({
      localPoint: [0.85, 0.45, 1.65],
      localNormal: [-0.6, 0, -0.8],
      impulse: 16_000,
      relativeSpeed: 22,
    });

    expect(frontLeft.health.engineHealth).toBeLessThan(0.75);
    expect(frontLeft.health.headlightsIntact).toBe(false);
    expect(frontLeft.health.taillightsIntact).toBe(true);
    expect(frontLeft.health.wheelIntegrity[0]).toBeLessThan(0.7);
    expect(frontLeft.health.wheelIntegrity[0]).toBeLessThan(frontLeft.health.wheelIntegrity[1]);
    expect(frontLeft.health.wheelIntegrity[2]).toBe(1);
    expect(frontLeft.health.wheelIntegrity[3]).toBe(1);
    expect(frontLeft.health.steeringPull).toBeGreaterThan(0.1);
    expect(frontLeft.health.chassisIntegrity).toBeLessThan(0.85);

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
      const u = (v % 520) / 519;
      const w = Math.floor(v / 520) / 499;
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

    sim.applyImpact({
      localPoint: [0, 0.65, 2.2],
      localNormal: [0, 0, -1],
      impulse: 6000,
      relativeSpeed: 14,
    });
    sim.reset();
    expect(normals[0]).toBe(origNormals[0]);
    expect(normals[vertexCount * 3 - 1]).toBe(origNormals[vertexCount * 3 - 1]);

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
    expect(mutated).toBeGreaterThan(1000);
    expect(untouched).toBeGreaterThan(100_000);

    expect(initMs).toBeLessThan(200);
    expect(avgImpactMs).toBeLessThan(25);

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
