import { describe, expect, it } from 'vitest';
import {
  classifyMaterialRole,
  createDefaultBuild,
  normalizeCarBuild,
  validateCarBuild,
  validateVehicleManifest,
  type VehicleManifest,
} from '../packages/vehicle-core/src/index.js';
import { LocalDentStubSimulator } from '../packages/damage-bridge/src/index.js';

const sampleManifest: VehicleManifest = {
  schemaVersion: 1,
  id: 'test-coupe',
  name: 'Test Coupe',
  author: 'Zach',
  sourceFile: 'test_coupe.blend',
  importedAt: '2026-11-25T00:00:00.000Z',
  modelUrl: '/cars/test-coupe/model.glb',
  bounds: {
    min: [-0.95, 0, -2.2],
    max: [0.95, 1.3, 2.2],
    size: [1.9, 1.3, 4.4],
    center: [0, 0.65, 0],
  },
  triangleCount: 12000,
  objectCount: 12,
  wheels: [
    { id: 'wheel-fl', corner: 'FL', objectName: 'wheel_FL', center: [-0.85, 0.34, 1.35], radius: 0.34, width: 0.25 },
  ],
  parts: [
    { id: 'part-spoiler', label: 'Spoiler', category: 'spoiler', objectName: 'part_spoiler', defaultVisible: true },
  ],
  slots: [],
  materialZones: [
    {
      id: 'mat-paint-primary',
      materialName: 'mat_paint_primary',
      role: 'primary',
      defaultColor: '#c81d25',
      meshNames: ['body_shell'],
    },
    {
      id: 'mat-rim',
      materialName: 'mat_rim',
      role: 'rim',
      defaultColor: '#d7dce2',
      meshNames: ['wheel_FL'],
    },
  ],
  hints: [],
};

describe('vehicle-core contracts', () => {
  it('validates a well-formed VehicleManifest and generates a valid default CarBuild', () => {
    expect(validateVehicleManifest(sampleManifest)).toBe(true);
    const build = createDefaultBuild(sampleManifest);
    expect(validateCarBuild(build)).toBe(true);
    expect(build.paintZones['mat-paint-primary']?.color).toBe('#c81d25');
    expect(build.partVisibility['part-spoiler']).toBe(true);
  });

  it('classifies Blender material names into paint booth roles', () => {
    expect(classifyMaterialRole('mat_paint_primary')).toBe('primary');
    expect(classifyMaterialRole('Body_Paint')).toBe('primary');
    expect(classifyMaterialRole('mat_rim_alloy')).toBe('rim');
    expect(classifyMaterialRole('trim_black')).toBe('trim');
    expect(classifyMaterialRole('trim')).toBe('trim');
    expect(classifyMaterialRole('Front_Windshield_Glass')).toBe('glass');
    expect(classifyMaterialRole('Windscreen')).toBe('glass');
    expect(classifyMaterialRole('Brake_Caliper_Accent')).toBe('accent');
    expect(classifyMaterialRole('mat_headlight_led')).toBe('headlight');
  });
});

describe('normalizeCarBuild', () => {
  it('round-trips a default build through JSON unchanged', () => {
    const build = createDefaultBuild(sampleManifest);
    expect(normalizeCarBuild(JSON.parse(JSON.stringify(build)), sampleManifest)).toEqual(build);
  });

  it('fills in fields that an older saved build does not have', () => {
    const legacy = {
      schemaVersion: 1,
      carId: 'test-coupe',
      buildName: 'Old save',
      updatedAt: '2026-01-01T00:00:00.000Z',
      paintZones: {},
      partVisibility: { 'part-spoiler': false },
      universalParts: { spoiler: 'gt-wing', roof: 'none', wheelStyle: 'stock' },
      stance: { rideHeightOffset: -0.03, wheelSpinSpeed: 0, frontSteerAngle: 14 },
      lightsOn: true,
    };
    const build = normalizeCarBuild(legacy, sampleManifest);
    expect(build).not.toBeNull();
    expect(build?.buildName).toBe('Old save');
    expect(build?.universalParts).toEqual({
      spoiler: 'gt-wing',
      roof: 'none',
      wheelStyle: 'stock',
      frontSplitter: false,
      towHook: false,
      exhaustTips: false,
    });
    expect(build?.stance).toEqual({ rideHeightOffset: -0.03, wheelSpinSpeed: 0, frontSteerAngle: 14, camberDeg: 0, trackOffset: 0 });
    expect(build?.partVisibility['part-spoiler']).toBe(false);
    expect(build?.paintZones['mat-paint-primary']?.color).toBe('#c81d25');
    expect(build?.rimFinish).toBeNull();
    expect(build?.glassTint).toBeNull();
    expect(build?.lightsOn).toBe(true);
  });

  it('clamps out-of-range values and drops zones, parts and options the car does not have', () => {
    const build = createDefaultBuild(sampleManifest);
    const tampered = JSON.parse(JSON.stringify(build));
    tampered.stance.camberDeg = -40;
    tampered.stance.trackOffset = 3;
    tampered.stance.rideHeightOffset = 'low';
    tampered.universalParts.spoiler = 'batwing';
    tampered.paintZones['mat-rim'] = { color: '#112233', finish: 'gloss', metalness: 7, roughness: -1, modified: true };
    tampered.paintZones['mat-paint-primary'] = { color: 'red' };
    tampered.paintZones['not-on-this-car'] = build.paintZones['mat-rim'];
    tampered.partVisibility['not-on-this-car'] = false;
    tampered.glassTint = { color: '#223344', darkness: 9 };

    const clean = normalizeCarBuild(tampered, sampleManifest);
    expect(clean?.stance.camberDeg).toBe(-6);
    expect(clean?.stance.trackOffset).toBe(0.05);
    expect(clean?.stance.rideHeightOffset).toBe(0);
    expect(clean?.universalParts.spoiler).toBe('stock');
    expect(clean?.paintZones['mat-rim']).toMatchObject({ color: '#112233', metalness: 1, roughness: 0, modified: true });
    expect(clean?.paintZones['mat-paint-primary']?.color).toBe('#c81d25');
    expect(clean?.paintZones['not-on-this-car']).toBeUndefined();
    expect(clean?.partVisibility['not-on-this-car']).toBeUndefined();
    expect(clean?.glassTint).toEqual({ color: '#223344', darkness: 1 });
  });

  it('rejects values that are not builds, and builds saved for another car', () => {
    expect(normalizeCarBuild(null, sampleManifest)).toBeNull();
    expect(normalizeCarBuild({ schemaVersion: 2 }, sampleManifest)).toBeNull();
    expect(normalizeCarBuild({ ...createDefaultBuild(sampleManifest), carId: 'other-car' }, sampleManifest)).toBeNull();
  });
});

describe('damage-bridge Phase 2 contract', () => {
  it('deforms vertices on impact and restores them cleanly on reset', () => {
    const rest = new Float32Array([0, 0.5, 2.0, 0, 0.5, -2.0]);
    const live = new Float32Array(rest);
    const sim = new LocalDentStubSimulator();

    sim.init({
      carId: 'test-coupe',
      massKg: 1350,
      meshes: [{ partId: 'body_shell', restPositions: rest, positions: live }],
    });

    const impactResult = sim.applyImpact({
      localPoint: [0, 0.5, 2.0],
      localNormal: [0, 0, -1],
      impulse: 3500,
      relativeSpeed: 14,
    });

    expect(impactResult.dirtyPartIds).toContain('body_shell');
    expect(live[2]).toBeLessThan(2.0); // front vertex pushed inward
    expect(live[5]).toBe(-2.0); // rear vertex untouched
    expect(impactResult.health.chassisIntegrity).toBeLessThan(1);

    const resetResult = sim.reset();
    expect(resetResult.dirtyPartIds).toContain('body_shell');
    expect(live[2]).toBeCloseTo(2.0);
    expect(resetResult.health.chassisIntegrity).toBe(1);
  });
});
