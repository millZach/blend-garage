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
  /** Optional: true when driving inside an enclosed concrete tunnel (adds real tunnel reverb). */
  inTunnel?: boolean;
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
  /** Oscillator waveform shape (used in non-worklet fallback). */
  waveform: OscillatorType;
  /** Base amplitude weight at idle/cruise. */
  baseGain: number;
  /** Additional amplitude weight added at high RPM & throttle load. */
  loadGain: number;
  /** Subtle detune in cents for organic multi-bank richness. */
  detuneCents?: number;
}

export interface EnginePhysicalParams {
  /** Number of cylinders in the 4-stroke cycle. */
  cylinders: number;
  /** Exact firing angles in degrees across one 720-degree 4-stroke cycle. */
  firingAnglesDeg: readonly number[];
  /** Exhaust bank assignment per cylinder firing (`0` = left bank, `1` = right bank). */
  cylinderBanks: readonly (0 | 1)[];
  /** Combustion pressure attack sharpness (0.6 = soft warm, 1.5 = razor crisp). */
  pulseSharpness: number;
  /** Exhaust blowdown tail duration at idle in milliseconds (2.0..9.0 ms). */
  pulseDecayMs: number;
  /** Turbulent exhaust gas noise mixed into each combustion pulse (0.05..0.45). */
  pulseTurbulence: number;
  /** Cycle-to-cycle stochastic combustion jitter (0.02..0.16) to eliminate robotic buzz. */
  cycleJitter: number;
  /** Left bank primary exhaust header acoustic delay in milliseconds (0.6..2.2 ms). */
  headerDelayLMs: number;
  /** Right bank primary exhaust header acoustic delay in milliseconds (0.6..2.2 ms). */
  headerDelayRMs: number;
  /** Collector / X-pipe cross-feed between left and right banks (0..0.5). */
  collectorCrossFeed: number;
  /** Main tailpipe waveguide acoustic delay in milliseconds (2.4..8.5 ms). */
  tailpipeDelayMs: number;
  /** Open-pipe inverted pressure reflection feedback magnitude (0.25..0.64). */
  pipeFeedback: number;
  /** Reflection low-pass damping (0.18 = metallic bright rasp, 0.72 = warm deep rumble). */
  pipeDamping: number;
  /** Helmholtz muffler / exhaust cavity resonance frequency in Hz (85..260 Hz). */
  mufflerResonanceHz: number;
  /** Muffler cavity resonance boost (0.1..0.8). */
  mufflerBody: number;
  /** Open-throttle intake plenum resonance frequency in Hz (350..1600 Hz). */
  intakeResonanceHz: number;
  /** Subtle mechanical valvetrain / timing gear mesh level (0..0.35). */
  crankcaseWhir: number;
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
  /** Main harmonic stack (used in non-worklet fallback synthesis). */
  harmonics: [EngineHarmonicLayer, EngineHarmonicLayer, EngineHarmonicLayer, EngineHarmonicLayer];
  /** Physical 4-stroke crankshaft combustion & dual-bank exhaust waveguide parameters. */
  physical: EnginePhysicalParams;
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
