export type Vec3 = [number, number, number];

export type PaintZoneRole =
  | 'primary'
  | 'secondary'
  | 'accent'
  | 'rim'
  | 'glass'
  | 'trim'
  | 'headlight'
  | 'taillight'
  | 'other';

export type PaintFinishType =
  | 'gloss'
  | 'metallic'
  | 'matte'
  | 'satin'
  | 'pearlescent'
  | 'chrome';

export interface PaintZoneState {
  color: string;
  finish: PaintFinishType;
  metalness: number;
  roughness: number;
  clearcoat: number;
  clearcoatRoughness: number;
  iridescence: number;
  /** Only overrides the original Blender PBR material when true. */
  modified?: boolean;
}

export interface MaterialZoneInfo {
  id: string;
  materialName: string;
  role: PaintZoneRole;
  defaultColor: string;
  meshNames: string[];
}

export interface WheelInfo {
  id: string;
  corner: 'FL' | 'FR' | 'RL' | 'RR' | 'unknown';
  objectName: string;
  center: Vec3;
  radius: number;
  width: number;
}

export interface PartInfo {
  id: string;
  label: string;
  category: string;
  objectName: string;
  defaultVisible: boolean;
}

export interface SlotAnchorInfo {
  id: string;
  category: string;
  objectName: string;
  position: Vec3;
  rotation: Vec3;
  scale: Vec3;
}

export interface VehicleBounds {
  min: Vec3;
  max: Vec3;
  size: Vec3;
  center: Vec3;
}

export interface VehicleManifest {
  schemaVersion: 1;
  id: string;
  name: string;
  author: string;
  sourceFile: string;
  importedAt: string;
  modelUrl: string;
  thumbnailUrl?: string;
  bounds: VehicleBounds;
  triangleCount: number;
  objectCount: number;
  wheels: WheelInfo[];
  parts: PartInfo[];
  slots: SlotAnchorInfo[];
  materialZones: MaterialZoneInfo[];
  hints: string[];
}

export interface GarageManifestEntry {
  id: string;
  name: string;
  author: string;
  vehicleUrl: string;
  modelUrl: string;
  thumbnailUrl?: string;
  importedAt: string;
}

export interface GarageManifest {
  schemaVersion: 1;
  generatedAt: string;
  cars: GarageManifestEntry[];
}

export const SPOILER_STYLES = ['stock', 'none', 'gt-wing', 'ducktail', 'street-lip'] as const;
export const ROOF_ACCESSORIES = ['none', 'roof-box', 'rally-lightbar'] as const;
export const WHEEL_OVERLAYS = ['stock', 'five-spoke', 'mesh-dish', 'aero-disc'] as const;

export type UniversalSpoilerStyle = (typeof SPOILER_STYLES)[number];
export type UniversalRoofAccessory = (typeof ROOF_ACCESSORIES)[number];
export type UniversalWheelOverlay = (typeof WHEEL_OVERLAYS)[number];

export interface UniversalPartsConfig {
  spoiler: UniversalSpoilerStyle;
  roof: UniversalRoofAccessory;
  wheelStyle: UniversalWheelOverlay;
  frontSplitter: boolean;
  towHook: boolean;
  exhaustTips: boolean;
}

export interface StanceConfig {
  rideHeightOffset: number; // meters, -0.08 to +0.12
  wheelSpinSpeed: number; // rad/s preview spin in showroom
  frontSteerAngle: number; // degrees, -35 to +35
  camberDeg: number; // degrees, -6 to +2 (negative leans the wheel tops inward)
  trackOffset: number; // meters each wheel is spaced outward, 0 to 0.05
}

/** Allowed ranges for every stance value, shared by the UI sliders and build validation. */
export const STANCE_LIMITS = {
  rideHeightOffset: { min: -0.08, max: 0.12 },
  wheelSpinSpeed: { min: 0, max: 40 },
  frontSteerAngle: { min: -35, max: 35 },
  camberDeg: { min: -6, max: 2 },
  trackOffset: { min: 0, max: 0.05 },
} as const satisfies Record<keyof StanceConfig, { min: number; max: number }>;

export interface GlassTintConfig {
  color: string;
  /** 0 = nearly clear, 1 = limo dark. */
  darkness: number;
}

export interface CarBuild {
  schemaVersion: 1;
  carId: string;
  buildName: string;
  updatedAt: string;
  paintZones: Record<string, PaintZoneState>;
  partVisibility: Record<string, boolean>;
  universalParts: UniversalPartsConfig;
  stance: StanceConfig;
  lightsOn: boolean;
  /** Finish for universal wheel faces and every rim-role zone. `null` keeps the stock rims. */
  rimFinish: PaintZoneState | null;
  /** Tint for every glass-role zone. `null` keeps the stock glass. */
  glassTint: GlassTintConfig | null;
}

export function createDefaultStance(): StanceConfig {
  return {
    rideHeightOffset: 0,
    wheelSpinSpeed: 0,
    frontSteerAngle: 0,
    camberDeg: 0,
    trackOffset: 0,
  };
}

export function createDefaultBuild(manifest: VehicleManifest): CarBuild {
  const paintZones: Record<string, PaintZoneState> = {};
  for (const zone of manifest.materialZones) {
    paintZones[zone.id] = getDefaultZoneState(zone.role, zone.defaultColor);
  }

  const partVisibility: Record<string, boolean> = {};
  for (const part of manifest.parts) {
    partVisibility[part.id] = part.defaultVisible;
  }

  return {
    schemaVersion: 1,
    carId: manifest.id,
    buildName: `${manifest.name} Stock`,
    updatedAt: new Date().toISOString(),
    paintZones,
    partVisibility,
    universalParts: {
      spoiler: 'stock',
      roof: 'none',
      wheelStyle: 'stock',
      frontSplitter: false,
      towHook: false,
      exhaustTips: false,
    },
    stance: createDefaultStance(),
    lightsOn: false,
    rimFinish: null,
    glassTint: null,
  };
}

const HEX_COLOR = /^#[0-9a-f]{6}$/i;
const FINISH_TYPES: readonly PaintFinishType[] = ['gloss', 'metallic', 'matte', 'satin', 'pearlescent', 'chrome'];

function clampNumber(value: unknown, min: number, max: number, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : fallback;
}

function pickOption<T extends string>(value: unknown, options: readonly T[], fallback: T): T {
  return options.includes(value as T) ? (value as T) : fallback;
}

/** Coerces untrusted JSON into a complete, in-range `PaintZoneState`, or `null` if it is not one. */
export function sanitizePaintZoneState(value: unknown, fallback: PaintZoneState): PaintZoneState | null {
  if (!value || typeof value !== 'object') return null;
  const v = value as Record<string, unknown>;
  if (typeof v.color !== 'string' || !HEX_COLOR.test(v.color)) return null;
  const state: PaintZoneState = {
    color: v.color.toLowerCase(),
    finish: pickOption(v.finish, FINISH_TYPES, fallback.finish),
    metalness: clampNumber(v.metalness, 0, 1, fallback.metalness),
    roughness: clampNumber(v.roughness, 0, 1, fallback.roughness),
    clearcoat: clampNumber(v.clearcoat, 0, 1, fallback.clearcoat),
    clearcoatRoughness: clampNumber(v.clearcoatRoughness, 0, 1, fallback.clearcoatRoughness),
    iridescence: clampNumber(v.iridescence, 0, 1, fallback.iridescence),
  };
  if (v.modified === true) state.modified = true;
  return state;
}

/**
 * Turns a saved or imported build (possibly written by an older version, or hand-edited) into a
 * complete `CarBuild` for this car: missing fields get stock defaults, numbers are clamped to their
 * ranges, and zones or parts the car does not have are dropped. Returns `null` when the value is not
 * a build at all or belongs to a different car.
 */
export function normalizeCarBuild(value: unknown, manifest: VehicleManifest): CarBuild | null {
  if (!validateCarBuild(value) || value.carId !== manifest.id) return null;
  const build = createDefaultBuild(manifest);
  const raw = value as unknown as Record<string, unknown>;

  if (typeof raw.buildName === 'string' && raw.buildName.trim()) build.buildName = raw.buildName.trim().slice(0, 80);
  if (typeof raw.updatedAt === 'string') build.updatedAt = raw.updatedAt;

  const zones = raw.paintZones as Record<string, unknown>;
  for (const zoneId of Object.keys(build.paintZones)) {
    const state = sanitizePaintZoneState(zones[zoneId], build.paintZones[zoneId]);
    if (state) build.paintZones[zoneId] = state;
  }

  const visibility = raw.partVisibility as Record<string, unknown>;
  for (const partId of Object.keys(build.partVisibility)) {
    if (typeof visibility[partId] === 'boolean') build.partVisibility[partId] = visibility[partId] as boolean;
  }

  const parts = raw.universalParts as Record<string, unknown>;
  build.universalParts = {
    spoiler: pickOption(parts.spoiler, SPOILER_STYLES, 'stock'),
    roof: pickOption(parts.roof, ROOF_ACCESSORIES, 'none'),
    wheelStyle: pickOption(parts.wheelStyle, WHEEL_OVERLAYS, 'stock'),
    frontSplitter: parts.frontSplitter === true,
    towHook: parts.towHook === true,
    exhaustTips: parts.exhaustTips === true,
  };

  const stance = raw.stance as Record<string, unknown>;
  for (const key of Object.keys(STANCE_LIMITS) as (keyof StanceConfig)[]) {
    build.stance[key] = clampNumber(stance[key], STANCE_LIMITS[key].min, STANCE_LIMITS[key].max, build.stance[key]);
  }

  build.lightsOn = raw.lightsOn === true;
  build.rimFinish = sanitizePaintZoneState(raw.rimFinish, getDefaultZoneState('rim', '#cfd4dc'));

  const tint = raw.glassTint as Record<string, unknown> | null | undefined;
  if (tint && typeof tint === 'object' && typeof tint.color === 'string' && HEX_COLOR.test(tint.color)) {
    build.glassTint = { color: tint.color.toLowerCase(), darkness: clampNumber(tint.darkness, 0, 1, 0.5) };
  }

  return build;
}

export function getDefaultZoneState(role: PaintZoneRole, color = '#d62828'): PaintZoneState {
  switch (role) {
    case 'primary':
    case 'secondary':
      return {
        color,
        finish: 'metallic',
        metalness: 0.72,
        roughness: 0.24,
        clearcoat: 1.0,
        clearcoatRoughness: 0.06,
        iridescence: 0.08,
      };
    case 'accent':
      return {
        color,
        finish: 'gloss',
        metalness: 0.35,
        roughness: 0.2,
        clearcoat: 0.9,
        clearcoatRoughness: 0.08,
        iridescence: 0,
      };
    case 'rim':
      return {
        color: color || '#cfd4dc',
        finish: 'metallic',
        metalness: 0.9,
        roughness: 0.22,
        clearcoat: 0.4,
        clearcoatRoughness: 0.15,
        iridescence: 0,
      };
    case 'trim':
      return {
        color: color || '#1c1f24',
        finish: 'satin',
        metalness: 0.12,
        roughness: 0.48,
        clearcoat: 0.15,
        clearcoatRoughness: 0.4,
        iridescence: 0,
      };
    case 'glass':
      return {
        color: color || '#182430',
        finish: 'gloss',
        metalness: 0.1,
        roughness: 0.06,
        clearcoat: 1.0,
        clearcoatRoughness: 0.04,
        iridescence: 0.12,
      };
    default:
      return {
        color: color || '#8892a0',
        finish: 'gloss',
        metalness: 0.25,
        roughness: 0.35,
        clearcoat: 0.5,
        clearcoatRoughness: 0.15,
        iridescence: 0,
      };
  }
}

export function validateVehicleManifest(value: unknown): value is VehicleManifest {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return (
    v.schemaVersion === 1 &&
    typeof v.id === 'string' &&
    v.id.length > 0 &&
    typeof v.name === 'string' &&
    typeof v.modelUrl === 'string' &&
    Array.isArray(v.wheels) &&
    Array.isArray(v.parts) &&
    Array.isArray(v.slots) &&
    Array.isArray(v.materialZones) &&
    typeof v.bounds === 'object' &&
    v.bounds !== null
  );
}

export function validateCarBuild(value: unknown): value is CarBuild {
  if (!value || typeof value !== 'object') return false;
  const b = value as Record<string, unknown>;
  return (
    b.schemaVersion === 1 &&
    typeof b.carId === 'string' &&
    typeof b.buildName === 'string' &&
    typeof b.paintZones === 'object' &&
    b.paintZones !== null &&
    typeof b.partVisibility === 'object' &&
    b.partVisibility !== null &&
    typeof b.universalParts === 'object' &&
    b.universalParts !== null &&
    typeof b.stance === 'object' &&
    b.stance !== null
  );
}

export function classifyMaterialRole(materialName: string): PaintZoneRole {
  const n = materialName.toLowerCase();
  if (n.includes('mat_paint_primary') || n.includes('body_paint') || n.includes('carpaint') || n.includes('paint_primary')) {
    return 'primary';
  }
  if (n.includes('mat_paint_secondary') || n.includes('paint_secondary') || n.includes('two_tone')) {
    return 'secondary';
  }
  if (n.includes('mat_paint_accent') || n.includes('caliper') || n.includes('accent') || n.includes('stripe')) {
    return 'accent';
  }
  if (n.includes('mat_headlight') || n.includes('headlight') || n.includes('drl') || n.includes('emitter_head')) {
    return 'headlight';
  }
  if (n.includes('mat_taillight') || n.includes('taillight') || n.includes('brakelight') || n.includes('emitter_tail')) {
    return 'taillight';
  }
  if (n.includes('mat_glass') || n.includes('glass') || n.includes('windshield') || n.includes('windscreen') || n.includes('window')) {
    return 'glass';
  }
  if (
    n.includes('mat_trim') ||
    /\btrim\b/.test(n) ||
    n.includes('trim_') ||
    n.includes('plastic') ||
    n.includes('polymer') ||
    n.includes('rubber') ||
    n.includes('tire') ||
    n.includes('tyre') ||
    n.includes('grille') ||
    n.includes('carbon')
  ) {
    return 'trim';
  }
  if (
    n.includes('mat_rim') ||
    /(^|[_\-\s])rims?($|[_\-\s])/.test(n) ||
    n.includes('alloy') ||
    n.includes('wheel_metal') ||
    n.includes('wheel graphite') ||
    n.includes('wheel_graphite')
  ) {
    return 'rim';
  }
  if (n.includes('paint') || /(^|[_\-\s])body($|[_\-\s])/.test(n) || n.includes('chassis') || n.includes('shell')) {
    return 'primary';
  }
  return 'other';
}
