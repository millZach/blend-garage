export type EngineArchetype = 'v12' | 'flat6' | 'i6-turbo' | 'v8-muscle' | 'v8-exotic' | 'v10';

export type DriveSurface = 'asphalt' | 'concrete' | 'gravel' | 'grass';

export type DriveCameraMode = 'chase' | 'chase-far' | 'hood' | 'bumper' | 'orbit';

export type AudioMode = 'shop' | 'drive' | 'idle';

export type ShiftDirection = 'up' | 'down';

export interface DriveAudioFrame {
  /** Frame delta time in seconds. */
  dt: number;
  /** Vehicle linear speed in meters per second. */
  speedMps: number;
  /** Current engine speed in RPM. */
  rpm: number;
  /** Engine idle speed in RPM. */
  idleRpm: number;
  /** Engine redline speed in RPM. */
  redlineRpm: number;
  /** Current gear (-1 = reverse, 0 = neutral, 1..N = forward). */
  gear: number;
  /** Throttle pedal position (0..1). */
  throttle: number;
  /** Brake pedal position (0..1). */
  brake: number;
  /** Whether handbrake / drift brake is engaged. */
  handbrake: boolean;
  /** Turbocharger boost spool level (0..1). */
  turboBoost: number;
  /** Normalized tire slip intensity (0..1+). */
  slipRatio: number;
  /** Normalized suspension/tire load on the ground (0..1+). */
  wheelLoad: number;
  /** Active ground surface under the tires. */
  surface: DriveSurface;
  /** Active driving camera perspective. */
  cameraMode: DriveCameraMode;
  /** True when all wheels are off the ground. */
  airborne: boolean;
  /** True while the driver holds the horn button. */
  hornActive: boolean;
  /** Continuous sliding metallic scrape intensity (0..1). */
  scrapeIntensity: number;
  /** Mechanical engine health (0..1, 1 = healthy). */
  engineHealth: number;
}

export interface CrashAudioEvent {
  /** Peak impact deceleration in G-force. */
  gForce: number;
  /** Impact relative speed in meters per second. */
  speedMps: number;
  /** Explicitly trigger glass shatter layer (also auto-triggered at gForce >= 18). */
  glassBreak?: boolean;
  /** Trigger tumbling detached panel clatter. */
  panelDetached?: boolean;
  /** Emphasize metallic body/guardrail resonators (defaults to true). */
  metallic?: boolean;
}

export interface AudioStateSnapshot {
  /** Whether Web Audio API is available in the current environment. */
  supported: boolean;
  /** Whether the AudioContext has been created and resumed after user gesture. */
  unlocked: boolean;
  /** Whether audio output is currently muted. */
  muted: boolean;
  /** Master volume scalar in [0, 1]. */
  volume: number;
}

export interface EngineHarmonicLayer {
  /** Multiplier relative to primary cylinder firing frequency. */
  ratio: number;
  /** Oscillator waveform shape. */
  waveform: OscillatorType;
  /** Base amplitude weight at idle/cruise. */
  baseGain: number;
  /** Additional amplitude weight added at high RPM & throttle load. */
  loadGain: number;
  /** Subtle detune in cents for organic multi-bank richness. */
  detuneCents?: number;
}

export interface EngineAcousticProfile {
  /** Unique profile identifier. */
  id: string;
  /** Human-readable description of the acoustic character. */
  label: string;
  /** Core engine archetype classification. */
  archetype: EngineArchetype;
  /** Default idle RPM for this engine profile. */
  idleRpm: number;
  /** Default redline RPM for this engine profile. */
  redlineRpm: number;
  /**
   * Firing pulses per revolution (cylinders / 2 for 4-stroke).
   * Primary firing Hz = (rpm / 60) * firingOrder.
   */
  firingOrder: number;
  /** Overall frequency scale tweak for exhaust timbre tuning. */
  pitchScale: number;
  /** Sub-fundamental crank/exhaust weight (0.5x firing frequency). */
  subGain: number;
  /** Main harmonic oscillator stack (4 oscillators). */
  harmonics: [EngineHarmonicLayer, EngineHarmonicLayer, EngineHarmonicLayer, EngineHarmonicLayer];
  /** Idle cam-lope AM/FM modulation depth (0..0.45). */
  idleLopeDepth: number;
  /** Idle cam-lope rate in Hz. */
  idleLopeHz: number;
  /** Asymmetric waveshaper drive amount (1.5..9). */
  saturationDrive: number;
  /** Waveshaper asymmetry bias (0..0.35) for warm even harmonics. */
  saturationBias: number;
  /** Exhaust low-pass cutoff at closed-throttle idle (Hz). */
  filterMinHz: number;
  /** Exhaust low-pass cutoff at full-throttle redline (Hz). */
  filterMaxHz: number;
  /** Signature exhaust/intake formant center frequency at idle (Hz). */
  formantMinHz: number;
  /** Signature exhaust/intake formant center frequency at redline (Hz). */
  formantMaxHz: number;
  /** Formant resonant peak gain in dB. */
  formantGainDb: number;
  /** Formant Q factor. */
  formantQ: number;
  /** High-RPM induction shriek / air-intake roar level (0..1). */
  inductionGain: number;
  /** Whether the engine has a prominent turbocharger & blow-off valve. */
  hasTurbo: boolean;
  /** Turbo spool whine level (0..1). */
  turboWhineGain: number;
  /** Turbo whine frequency range [minHz, maxHz]. */
  turboPitchRange: [number, number];
  /** Blow-off valve flutter intensity (0..1). */
  bovIntensity: number;
  /** Lift-off exhaust crackle & overrun burble intensity (0..1). */
  crackleIntensity: number;
  /** Upshift ignition-cut pop strength (0..1). */
  shiftPopIntensity: number;
  /** Starter motor cranking fundamental frequency (Hz). */
  starterCrankHz: number;
  /** Overall profile trim multiplier for balanced loudness across cars. */
  outputTrim: number;
  /**
   * Optional electric hypercar inverter/turbine blend (0..1).
   * When > 0.5, blends futuristic dual-motor whine and suppresses combustion crackles.
   */
  electricWhine?: number;
}

export type CarProfileHint =
  | string
  | {
      id?: string | null;
      name?: string | null;
      category?: string | null;
    };

export interface SoundEngineOptions {
  /** Optional factory to supply a custom or mocked AudioContext (used in tests). */
  audioContextFactory?: () => AudioContext;
  /** Initial master volume in [0, 1] (default 0.78). */
  initialVolume?: number;
  /** Initial muted flag (default false). */
  initialMuted?: boolean;
}
