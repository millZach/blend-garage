import type { MechanicalHealth } from '@blend-garage/damage-bridge';
import type { CarBuild, PaintZoneRole, VehicleManifest } from '@blend-garage/vehicle-core';
import type { AudioStateSnapshot } from './audio';

/** The three screens of the app: browsing cars in the photo bay, working on one in the shop, or driving in the open world. */
export type Screen = 'selector' | 'shop' | 'drive';

export type DriveCameraView = 'chase' | 'chase-far' | 'hood' | 'bumper' | 'orbit' | 'inspect';

export const DRIVE_CAMERA_VIEWS: { id: DriveCameraView; label: string }[] = [
  { id: 'chase', label: 'Chase' },
  { id: 'chase-far', label: 'Far Chase' },
  { id: 'hood', label: 'Hood' },
  { id: 'bumper', label: 'Bumper' },
  { id: 'orbit', label: 'Orbit' },
  { id: 'inspect', label: 'Inspect' },
];

export type DriveInputSource = 'keyboard' | 'gamepad';

export interface DriveSnapshot {
  speedKmh: number;
  speedMph: number;
  rpm: number;
  maxRpm: number;
  /** -1 = reverse, 0 = neutral, 1..6 = forward gears. */
  gear: number;
  throttle: number;
  brake: number;
  steer: number;
  handbrake: boolean;
  cameraView: DriveCameraView;
  inputSource: DriveInputSource;
  gamepadName: string | null;
  health: MechanicalHealth;
  lastImpactG: number;
  totalImpacts: number;
  spawnName: string;
  lightsOn: boolean;
  turboBoost: number;
  hornActive: boolean;
  inTunnel: boolean;
}

export type CameraMode = 'orbit' | 'walk' | 'fly';

export const CAMERA_PRESETS = [
  { id: 'hero', label: 'Hero' },
  { id: 'front', label: 'Front' },
  { id: 'rear', label: 'Rear' },
  { id: 'side', label: 'Side' },
  { id: 'wheel', label: 'Wheel' },
  { id: 'under', label: 'Underside' },
  { id: 'top', label: 'Top' },
] as const;
export type CameraPresetId = (typeof CAMERA_PRESETS)[number]['id'];

export const LIGHTING_MOODS = [
  { id: 'daylight', label: 'Bright daylight', blurb: 'Skylights and every LED bay on' },
  { id: 'studio', label: 'Detailing studio', blurb: 'Hex grid overhead, dark walls' },
  { id: 'night', label: 'Night shift', blurb: 'Warm worklights in a dark shop' },
  { id: 'golden', label: 'Golden bay', blurb: 'Low sun through the open door' },
] as const;
export type LightingMoodId = (typeof LIGHTING_MOODS)[number]['id'];

export interface CatalogCar {
  id: string;
  /** Display name with model codes tidied (for example "LP700-4"). */
  name: string;
  /** First word of the name, shown small above the model. */
  make: string;
  model: string;
  author: string;
  vehicleUrl: string;
  modelUrl: string;
  importedAt: string;
  /** The car's small vehicle.json. `null` until it has been fetched, or if it failed validation. */
  manifest: VehicleManifest | null;
}

export type LoadPhase = 'manifest' | 'download' | 'decode' | 'prepare' | 'ready' | 'error';

export interface CarLoadState {
  carId: string;
  phase: LoadPhase;
  /** 0..1 across the whole load. */
  progress: number;
  error: string | null;
}

export type WheelCorner = 'FL' | 'FR' | 'RL' | 'RR';

/** What the rig worked out about the loaded car, for the HUD to describe. */
export interface RigSummary {
  size: [number, number, number];
  /** Wheels that were located on the model and can spin, steer and camber. */
  wheels: { corner: WheelCorner; radius: number; width: number }[];
  wheelbase: number | null;
  sourceMeshes: number;
  drawCalls: number;
  triangles: number;
  /**
   * The role each paintable zone plays on this car. Usually the manifest's, except that the zone found
   * to be the real body paint is always `primary`.
   */
  zoneRoles: Record<string, PaintZoneRole>;
  /** The zone each role shortcut selects. For `primary` this is the real body paint. */
  roleLeads: Partial<Record<PaintZoneRole, string>>;
  /** Zone ids per role, lead first. */
  roleZones: Partial<Record<PaintZoneRole, string[]>>;
  caliperZones: string[];
  stockSpoilerParts: number;
  hasHeadlights: boolean;
  hasTaillights: boolean;
}

export interface LiftState {
  /** Current height of the car above the floor, meters. */
  height: number;
  target: number;
  max: number;
  moving: boolean;
}

export interface PerfStats {
  fps: number;
  drawCalls: number;
  triangles: number;
}

export interface Notice {
  id: number;
  tone: 'info' | 'error';
  text: string;
}

export type CatalogStatus = 'loading' | 'ready' | 'error';

export interface EngineSnapshot {
  screen: Screen;
  /** Set while the car is transitioning between screens; controls are locked. */
  busy: 'rolling-in' | 'leaving' | 'entering-drive' | 'exiting-drive' | null;
  catalogStatus: CatalogStatus;
  catalogError: string | null;
  cars: CatalogCar[];
  selectedCarId: string | null;
  load: CarLoadState | null;
  /** Manifest, rig summary and build of the car that is on stage right now. */
  manifest: VehicleManifest | null;
  rig: RigSummary | null;
  build: CarBuild | null;
  /** Epoch ms of the last auto-save of `build`, or `null` if it has not been saved yet. */
  savedAt: number | null;
  lift: LiftState;
  mood: LightingMoodId;
  cameraMode: CameraMode;
  cameraPreset: CameraPresetId | null;
  perf: PerfStats;
  notice: Notice | null;
  /** 0..1 opacity of the black curtain the HUD draws for cut transitions. */
  curtain: number;
  /** Live driving telemetry & crash damage state while `screen === 'drive'`, otherwise `null`. */
  drive: DriveSnapshot | null;
  /** Procedural Web Audio engine status (muted, master volume, unlocked). */
  audio: AudioStateSnapshot;
}

/** Pixels of the viewport covered by HUD panels, so the camera can center the car in what is left. */
export interface ViewInsets {
  left: number;
  right: number;
  top: number;
  bottom: number;
}
