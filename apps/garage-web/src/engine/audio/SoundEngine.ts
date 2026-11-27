import { CrashAudioSynth } from './CrashAudioSynth';
import { DrivingFoleySynth } from './DrivingFoleySynth';
import { EngineSynth } from './EngineSynth';
import { GarageFoleySynth } from './GarageFoleySynth';
import { clampFinite, createNoiseBank, safeSetTarget } from './dsp';
import { ENGINE_PROFILES, resolveEngineProfile } from './engineProfiles';
import type {
  AudioMode,
  AudioStateSnapshot,
  CarProfileHint,
  CrashAudioEvent,
  DriveAudioFrame,
  EngineAcousticProfile,
  ShiftDirection,
  SoundEngineOptions,
} from './types';

type AudioContextConstructor = new () => AudioContext;

function getNativeAudioContextCtor(): AudioContextConstructor | null {
  if (typeof globalThis === 'undefined') return null;
  const g = globalThis as unknown as {
    AudioContext?: AudioContextConstructor;
    webkitAudioContext?: AudioContextConstructor;
  };
  return typeof g.AudioContext === 'function'
    ? g.AudioContext
    : typeof g.webkitAudioContext === 'function'
      ? g.webkitAudioContext
      : null;
}

/**
 * Unified, pure-TypeScript procedural Web Audio API sound engine for Blend Garage.
 *
 * - Safe lazy `AudioContext` initialization on `unlock()` for browser autoplay compliance.
 * - Every public method is a safe no-op before unlock, when unsupported, or after `dispose()`.
 * - Master `DynamicsCompressorNode` soft limiter prevents clipping even under redline + heavy crashes.
 * - Zero React imports, zero external runtime dependencies.
 */
export class SoundEngine {
  private readonly audioContextFactory?: () => AudioContext;
  private readonly listeners = new Set<() => void>();

  private state: AudioStateSnapshot;
  private mode: AudioMode = 'idle';
  private paused = false;
  private profile: EngineAcousticProfile = ENGINE_PROFILES.v10;
  private disposed = false;

  // Lazily created audio graph
  private ctx: AudioContext | null = null;
  private mixBus: GainNode | null = null;
  private limiter: DynamicsCompressorNode | null = null;
  private masterGain: GainNode | null = null;
  private engineBus: GainNode | null = null;
  private foleyBus: GainNode | null = null;
  private crashBus: GainNode | null = null;
  private garageBus: GainNode | null = null;

  private engineSynth: EngineSynth | null = null;
  private foleySynth: DrivingFoleySynth | null = null;
  private crashSynth: CrashAudioSynth | null = null;
  private garageSynth: GarageFoleySynth | null = null;

  private unlockPromise: Promise<boolean> | null = null;

  constructor(options: SoundEngineOptions = {}) {
    this.audioContextFactory = options.audioContextFactory;
    const supported =
      typeof options.audioContextFactory === 'function' || getNativeAudioContextCtor() !== null;
    this.state = {
      supported,
      unlocked: false,
      muted: Boolean(options.initialMuted),
      volume: clampFinite(options.initialVolume ?? 0.78, 0, 1, 0.78),
    };
  }

  // ------------------------------------------------------------------ state & lifecycle

  /** Returns the current immutable audio state snapshot (compatible with `useSyncExternalStore`). */
  getState = (): AudioStateSnapshot => this.state;

  /** Subscribes to changes in `AudioStateSnapshot` (`supported`, `unlocked`, `muted`, `volume`). */
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  /**
   * Creates (if needed) and resumes the `AudioContext`.
   * Call from a user gesture (`pointerdown`, `keydown`, or button click) to satisfy browser autoplay rules.
   * Never throws or rejects; returns `true` when audio is unlocked and ready.
   */
  async unlock(): Promise<boolean> {
    if (this.disposed || !this.state.supported) return false;
    if (this.state.unlocked && this.ctx && this.ctx.state === 'running') return true;
    if (this.unlockPromise) return this.unlockPromise;

    this.unlockPromise = this.performUnlock().finally(() => {
      this.unlockPromise = null;
    });
    return this.unlockPromise;
  }

  /** Sets mute state immediately and ramps master gain without clicking. */
  setMuted(muted: boolean): void {
    const next = Boolean(muted);
    if (next === this.state.muted) return;
    this.updateState({ muted: next });
    this.applyMasterGain();
  }

  /** Toggles mute state and returns the new muted flag. */
  toggleMute(): boolean {
    const next = !this.state.muted;
    this.setMuted(next);
    return next;
  }

  /** Sets master volume in `[0, 1]` with finite clamping and smooth gain ramp. */
  setMasterVolume(volume: number): void {
    const clamped = clampFinite(volume, 0, 1, this.state.volume);
    if (Math.abs(clamped - this.state.volume) < 1e-6) return;
    this.updateState({ volume: clamped });
    this.applyMasterGain();
  }

  /** Smoothly pauses or resumes audio output (e.g. when the tab loses visibility). */
  setPaused(paused: boolean): void {
    const next = Boolean(paused);
    if (next === this.paused) return;
    this.paused = next;
    this.applyMasterGain();
    if (!next && this.ctx && this.ctx.state === 'suspended' && this.state.unlocked && !this.disposed) {
      try {
        void this.ctx.resume().catch(() => {});
      } catch {
        // Ignore resume errors outside user gesture.
      }
    }
  }

  /** Switches active scene audio mode (`'shop'` | `'drive'` | `'idle'`) with smooth crossfades. */
  setMode(mode: AudioMode): void {
    this.mode = mode;
    if (!this.isGraphReady()) return;

    const inDrive = mode === 'drive';
    this.engineSynth?.setActive(inDrive);
    this.foleySynth?.setActive(inDrive);
    this.garageSynth?.setMode(mode);

    if (!inDrive) {
      this.crashSynth?.updateScrape(0, 0);
      this.foleySynth?.setHorn(false);
    }
  }

  getMode(): AudioMode {
    return this.mode;
  }

  /** Resolves and activates the engine acoustic profile for the selected vehicle. */
  setCarProfile(car: CarProfileHint | EngineAcousticProfile | null): EngineAcousticProfile {
    const resolved = resolveEngineProfile(car);
    this.profile = resolved;
    this.engineSynth?.setProfile(resolved);
    return resolved;
  }

  getCarProfile(): EngineAcousticProfile {
    return this.profile;
  }

  // ------------------------------------------------------------------ open-world driving audio

  /** Updates continuous engine, road/tire/wind foley, horn, and metallic scrape from live telemetry. */
  updateDrive(frame: DriveAudioFrame): void {
    if (!this.isAudibleReady() || this.mode !== 'drive') return;
    this.engineSynth?.update(frame);
    this.foleySynth?.update(frame);
    this.crashSynth?.updateScrape(frame.scrapeIntensity, frame.speedMps);
  }

  /** Plays starter cranking + cold-start rev bark (or EV power-on chime for electric hypercars). */
  playIgnition(): void {
    if (!this.isAudibleReady()) return;
    this.engineSynth?.playIgnition();
  }

  /** Plays upshift ignition-cut pop or downshift rev-match throttle blip. */
  playShift(direction: ShiftDirection, rpm?: number): void {
    if (!this.isAudibleReady()) return;
    this.engineSynth?.playShift(direction, rpm);
  }

  /** Activates or releases the dual-tone automotive horn. */
  setHorn(active: boolean): void {
    if (!this.isGraphReady()) return;
    this.foleySynth?.setHorn(active);
  }

  /** Plays a G-force-scaled crash impact (sub-boom, sheet metal, resonators, debris, glass). */
  playImpact(event: CrashAudioEvent): void {
    if (!this.isAudibleReady()) return;
    this.crashSynth?.playImpact(event);
  }

  /** Plays a tumbling detached bumper/hood clatter sequence. */
  playPartDetach(): void {
    if (!this.isAudibleReady()) return;
    this.crashSynth?.playPartDetach();
  }

  /** Updates continuous metallic guardrail/asphalt scrape noise directly. */
  updateScrape(intensity: number, speedMps: number): void {
    if (!this.isGraphReady()) return;
    this.crashSynth?.updateScrape(intensity, speedMps);
  }

  /** Plays pneumatic air-wrench zip-zip + clean repair latch chime. */
  playRepair(): void {
    if (!this.isAudibleReady()) return;
    this.crashSynth?.playRepair();
  }

  /** Plays clean hydraulic latch + road reset chime. */
  playReset(): void {
    if (!this.isAudibleReady()) return;
    this.crashSynth?.playReset();
  }

  // ------------------------------------------------------------------ garage, shop & UI foley

  /** Plays HVLP paint spray-gun hiss burst. */
  playPaintSpray(): void {
    if (!this.isAudibleReady()) return;
    this.garageSynth?.playPaintSpray();
  }

  /** Plays pneumatic impact wrench tightening sound when installing a part. */
  playPartInstall(): void {
    if (!this.isAudibleReady()) return;
    this.garageSynth?.playPartInstall();
  }

  /** Plays reverse socket ratchet sound when removing/hiding a part. */
  playPartRemove(): void {
    if (!this.isAudibleReady()) return;
    this.garageSynth?.playPartRemove();
  }

  /** Plays multi-wrench mechanical sweep when resetting a build to stock. */
  playStockReset(): void {
    if (!this.isAudibleReady()) return;
    this.garageSynth?.playStockReset();
  }

  /** Plays crisp automotive relay toggle click when switching headlights or shop lighting. */
  playLightSwitch(): void {
    if (!this.isAudibleReady()) return;
    this.garageSynth?.playLightSwitch();
  }

  /** Plays subtle airy swoosh on camera preset or bay switches. */
  playCameraSwoosh(): void {
    if (!this.isAudibleReady()) return;
    this.garageSynth?.playCameraSwoosh();
  }

  /**
   * Plays subtle garage bay door rumble + brief engine rev preview for the chosen car.
   * Passing `car` updates the active engine profile before previewing.
   */
  playCarSelect(car?: CarProfileHint | EngineAcousticProfile | null): void {
    if (car !== undefined && car !== null) {
      this.setCarProfile(car);
    }
    if (!this.isAudibleReady()) return;
    const previewProfile = this.profile;
    this.garageSynth?.playCarSelect(() => {
      this.engineSynth?.playRevPreview(previewProfile);
    });
  }

  /** Plays ultra-clean, subtle tactile mechanical UI micro-click. */
  playUiClick(): void {
    if (!this.isAudibleReady()) return;
    this.garageSynth?.playUiClick();
  }

  /** Controls the subtle hydraulic 2-post lift hum while moving inside the Mechanics Shop. */
  setLiftMoving(moving: boolean): void {
    if (!this.isGraphReady()) return;
    this.garageSynth?.setLiftMoving(moving);
  }

  /** Cleanly fades out, stops all audio nodes, closes the AudioContext, and detaches listeners. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;

    const ctx = this.ctx;
    if (ctx && this.masterGain) {
      safeSetTarget(this.masterGain.gain, 0, ctx.currentTime, 0.015, 0, 1);
    }

    this.engineSynth?.dispose();
    this.foleySynth?.dispose();
    this.crashSynth?.dispose();
    this.garageSynth?.dispose();

    this.engineSynth = null;
    this.foleySynth = null;
    this.crashSynth = null;
    this.garageSynth = null;

    const buses: (AudioNode | null)[] = [
      this.engineBus,
      this.foleyBus,
      this.crashBus,
      this.garageBus,
      this.mixBus,
      this.limiter,
      this.masterGain,
    ];
    for (const node of buses) {
      try {
        node?.disconnect();
      } catch {
        // Ignore already-disconnected nodes.
      }
    }

    this.engineBus = null;
    this.foleyBus = null;
    this.crashBus = null;
    this.garageBus = null;
    this.mixBus = null;
    this.limiter = null;
    this.masterGain = null;
    this.ctx = null;

    if (ctx && typeof ctx.close === 'function' && ctx.state !== 'closed') {
      try {
        void ctx.close().catch(() => {});
      } catch {
        // Ignore close errors.
      }
    }

    this.updateState({ unlocked: false });
    this.listeners.clear();
  }

  // ------------------------------------------------------------------ internals

  private async performUnlock(): Promise<boolean> {
    try {
      if (!this.ctx) {
        const ctx = this.createAudioContext();
        if (!ctx || this.disposed) {
          this.updateState({ supported: false, unlocked: false });
          return false;
        }
        this.ctx = ctx;
        this.buildAudioGraph(ctx);
      }

      if (this.ctx.state === 'suspended' && typeof this.ctx.resume === 'function') {
        await this.ctx.resume();
      }

      if (this.disposed || !this.ctx) return false;

      const running = this.ctx.state === 'running' || this.ctx.state === undefined;
      this.updateState({ unlocked: running });
      this.applyMasterGain();
      // Sync current mode & profile onto the newly active graph
      this.setMode(this.mode);
      return running;
    } catch {
      return false;
    }
  }

  private createAudioContext(): AudioContext | null {
    try {
      if (this.audioContextFactory) {
        return this.audioContextFactory();
      }
      const Ctor = getNativeAudioContextCtor();
      return Ctor ? new Ctor() : null;
    } catch {
      return null;
    }
  }

  private buildAudioGraph(ctx: AudioContext): void {
    // Master output stage: Sub-buses -> Mix Bus -> DynamicsCompressor Soft Limiter -> Master Gain -> Destination
    const masterGain = ctx.createGain();
    masterGain.gain.value = 0;
    masterGain.connect(ctx.destination);

    const limiter = ctx.createDynamicsCompressor();
    limiter.threshold.value = -6;
    limiter.knee.value = 10;
    limiter.ratio.value = 12;
    limiter.attack.value = 0.003;
    limiter.release.value = 0.12;
    limiter.connect(masterGain);

    const mixBus = ctx.createGain();
    mixBus.gain.value = 1;
    mixBus.connect(limiter);

    const engineBus = ctx.createGain();
    engineBus.gain.value = 0.86;
    engineBus.connect(mixBus);

    const foleyBus = ctx.createGain();
    foleyBus.gain.value = 0.82;
    foleyBus.connect(mixBus);

    const crashBus = ctx.createGain();
    crashBus.gain.value = 0.94;
    crashBus.connect(mixBus);

    const garageBus = ctx.createGain();
    garageBus.gain.value = 0.86;
    garageBus.connect(mixBus);

    const noise = createNoiseBank(ctx);

    this.masterGain = masterGain;
    this.limiter = limiter;
    this.mixBus = mixBus;
    this.engineBus = engineBus;
    this.foleyBus = foleyBus;
    this.crashBus = crashBus;
    this.garageBus = garageBus;

    this.engineSynth = new EngineSynth(ctx, engineBus, noise, this.profile);
    this.foleySynth = new DrivingFoleySynth(ctx, foleyBus, noise);
    this.crashSynth = new CrashAudioSynth(ctx, crashBus, noise);
    this.garageSynth = new GarageFoleySynth(ctx, garageBus, noise);
  }

  private applyMasterGain(): void {
    if (!this.ctx || !this.masterGain || this.disposed) return;
    const effective = this.state.muted || this.paused || !this.state.unlocked ? 0 : this.state.volume;
    safeSetTarget(this.masterGain.gain, effective, this.ctx.currentTime, 0.025, 0, 1);
  }

  private isGraphReady(): boolean {
    return !this.disposed && this.ctx !== null && this.state.unlocked;
  }

  private isAudibleReady(): boolean {
    return this.isGraphReady() && !this.paused;
  }

  private updateState(patch: Partial<AudioStateSnapshot>): void {
    const next: AudioStateSnapshot = { ...this.state, ...patch };
    if (
      next.supported === this.state.supported &&
      next.unlocked === this.state.unlocked &&
      next.muted === this.state.muted &&
      next.volume === this.state.volume
    ) {
      return;
    }
    this.state = next;
    for (const listener of [...this.listeners]) {
      try {
        listener();
      } catch {
        // Isolate subscriber errors.
      }
    }
  }
}
