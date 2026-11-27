import { describe, expect, it, vi } from 'vitest';
import {
  ELECTRIC_HYPERCAR_PROFILE,
  ENGINE_PROFILES,
  SoundEngine,
  getEngineProfile,
  normalizeDriveSurface,
  resolveEngineProfile,
  type AudioStateSnapshot,
  type DriveAudioFrame,
  type EngineArchetype,
} from '../apps/garage-web/src/engine/audio/index';

// ---------------------------------------------------------------------------
// Strict Web Audio API Mock (enforces finite AudioParam & positive exp-ramp rules)
// ---------------------------------------------------------------------------

interface ParamEvent {
  op: 'set' | 'target' | 'linear' | 'exp';
  value: number;
  time: number;
  timeConstant?: number;
}

class MockAudioParam {
  value: number;
  readonly events: ParamEvent[] = [];

  constructor(initial = 0) {
    this.value = initial;
  }

  private assertFinite(val: number, label: string): void {
    if (!Number.isFinite(val)) {
      throw new TypeError(`Non-finite AudioParam ${label}: ${val}`);
    }
  }

  setValueAtTime(value: number, startTime: number): this {
    this.assertFinite(value, 'value');
    this.assertFinite(startTime, 'startTime');
    this.value = value;
    this.events.push({ op: 'set', value, time: startTime });
    return this;
  }

  setTargetAtTime(target: number, startTime: number, timeConstant: number): this {
    this.assertFinite(target, 'target');
    this.assertFinite(startTime, 'startTime');
    this.assertFinite(timeConstant, 'timeConstant');
    if (timeConstant <= 0) {
      throw new RangeError(`timeConstant must be > 0, got ${timeConstant}`);
    }
    this.value = target;
    this.events.push({ op: 'target', value: target, time: startTime, timeConstant });
    return this;
  }

  linearRampToValueAtTime(value: number, endTime: number): this {
    this.assertFinite(value, 'value');
    this.assertFinite(endTime, 'endTime');
    this.value = value;
    this.events.push({ op: 'linear', value, time: endTime });
    return this;
  }

  exponentialRampToValueAtTime(value: number, endTime: number): this {
    this.assertFinite(value, 'value');
    this.assertFinite(endTime, 'endTime');
    if (value <= 0) {
      throw new RangeError(`exponentialRampToValueAtTime requires value > 0, got ${value}`);
    }
    this.value = value;
    this.events.push({ op: 'exp', value, time: endTime });
    return this;
  }
}

class MockAudioNode {
  readonly connections: unknown[] = [];
  disconnected = false;

  connect(dest: unknown): unknown {
    this.connections.push(dest);
    return dest;
  }

  disconnect(): void {
    this.disconnected = true;
  }
}

class MockGainNode extends MockAudioNode {
  readonly gain = new MockAudioParam(1);
}

class MockBiquadFilterNode extends MockAudioNode {
  type: BiquadFilterType = 'lowpass';
  readonly frequency = new MockAudioParam(350);
  readonly Q = new MockAudioParam(1);
  readonly gain = new MockAudioParam(0);
}

class MockWaveShaperNode extends MockAudioNode {
  curve: Float32Array | null = null;
  oversample: OverSampleType = 'none';
}

class MockDynamicsCompressorNode extends MockAudioNode {
  readonly threshold = new MockAudioParam(-24);
  readonly knee = new MockAudioParam(30);
  readonly ratio = new MockAudioParam(12);
  readonly attack = new MockAudioParam(0.003);
  readonly release = new MockAudioParam(0.25);
}

class MockScheduledSourceNode extends MockAudioNode {
  started = false;
  stopped = false;
  startTime = 0;
  stopTime: number | null = null;
  onended: (() => void) | null = null;

  start(when = 0): void {
    if (!Number.isFinite(when)) throw new TypeError(`Non-finite start time: ${when}`);
    this.started = true;
    this.startTime = when;
  }

  stop(when = 0): void {
    if (!Number.isFinite(when)) throw new TypeError(`Non-finite stop time: ${when}`);
    this.stopped = true;
    this.stopTime = when;
  }
}

class MockOscillatorNode extends MockScheduledSourceNode {
  type: OscillatorType = 'sine';
  readonly frequency = new MockAudioParam(440);
  readonly detune = new MockAudioParam(0);
}

class MockAudioBuffer {
  readonly sampleRate: number;
  readonly length: number;
  readonly numberOfChannels: number;
  private readonly channels: Float32Array[];

  constructor(channels: number, length: number, sampleRate: number) {
    this.numberOfChannels = channels;
    this.length = length;
    this.sampleRate = sampleRate;
    this.channels = Array.from({ length: channels }, () => new Float32Array(length));
  }

  getChannelData(channel: number): Float32Array {
    return this.channels[channel];
  }
}

class MockBufferSourceNode extends MockScheduledSourceNode {
  buffer: MockAudioBuffer | null = null;
  loop = false;
  readonly playbackRate = new MockAudioParam(1);
}

class MockAudioContext {
  state: AudioContextState = 'suspended';
  sampleRate = 48000;
  currentTime = 0;
  readonly destination = new MockAudioNode();

  readonly gains: MockGainNode[] = [];
  readonly oscillators: MockOscillatorNode[] = [];
  readonly filters: MockBiquadFilterNode[] = [];
  readonly shapers: MockWaveShaperNode[] = [];
  readonly compressors: MockDynamicsCompressorNode[] = [];
  readonly bufferSources: MockBufferSourceNode[] = [];
  readonly buffers: MockAudioBuffer[] = [];

  resumeCalls = 0;
  closeCalls = 0;
  failResume = false;

  advanceTime(seconds: number): void {
    this.currentTime += seconds;
  }

  async resume(): Promise<void> {
    this.resumeCalls += 1;
    if (this.failResume) {
      throw new Error('Autoplay blocked');
    }
    this.state = 'running';
  }

  async suspend(): Promise<void> {
    this.state = 'suspended';
  }

  async close(): Promise<void> {
    this.closeCalls += 1;
    this.state = 'closed';
  }

  createGain(): MockGainNode {
    const n = new MockGainNode();
    this.gains.push(n);
    return n;
  }

  createOscillator(): MockOscillatorNode {
    const n = new MockOscillatorNode();
    this.oscillators.push(n);
    return n;
  }

  createBiquadFilter(): MockBiquadFilterNode {
    const n = new MockBiquadFilterNode();
    this.filters.push(n);
    return n;
  }

  createWaveShaper(): MockWaveShaperNode {
    const n = new MockWaveShaperNode();
    this.shapers.push(n);
    return n;
  }

  createDynamicsCompressor(): MockDynamicsCompressorNode {
    const n = new MockDynamicsCompressorNode();
    this.compressors.push(n);
    return n;
  }

  createBufferSource(): MockBufferSourceNode {
    const n = new MockBufferSourceNode();
    this.bufferSources.push(n);
    return n;
  }

  createBuffer(channels: number, length: number, sampleRate: number): MockAudioBuffer {
    const b = new MockAudioBuffer(channels, length, sampleRate);
    this.buffers.push(b);
    return b;
  }
}

function makeDriveFrame(overrides: Partial<DriveAudioFrame> = {}): DriveAudioFrame {
  return {
    dt: 1 / 60,
    speedMps: 24,
    rpm: 3800,
    idleRpm: 900,
    redlineRpm: 8500,
    gear: 3,
    throttle: 0.65,
    brake: 0,
    handbrake: false,
    turboBoost: 0.45,
    slipRatio: 0.1,
    wheelLoad: 1.0,
    surface: 'asphalt',
    cameraMode: 'chase',
    airborne: false,
    hornActive: false,
    scrapeIntensity: 0,
    engineHealth: 1.0,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// 1. Engine Profile Resolution & Surface Normalization
// ---------------------------------------------------------------------------

describe('engineProfiles & surface helpers', () => {
  it('maps every car in the Blend Garage fleet to its intended acoustic profile', () => {
    expect(resolveEngineProfile('lamborghini-aventador-lp700-4').archetype).toBe('v12');
    expect(resolveEngineProfile('lamborghini-aventador-lp700-4').redlineRpm).toBe(8500);

    expect(resolveEngineProfile('porsche-911-gt3rs-astra-white').archetype).toBe('flat6');
    expect(resolveEngineProfile('porsche-911-gt3rs-astra-white').redlineRpm).toBe(9000);

    const supraAstra = resolveEngineProfile('ff1-toyota-supra-astra');
    const supraNeon = resolveEngineProfile('ff1-toyota-supra-gemini-neon');
    expect(supraAstra.archetype).toBe('i6-turbo');
    expect(supraNeon.archetype).toBe('i6-turbo');
    expect(supraAstra.hasTurbo).toBe(true);
    expect(supraAstra.turboWhineGain).toBeGreaterThan(0.5);
    expect(supraAstra.bovIntensity).toBeGreaterThan(0.5);

    expect(resolveEngineProfile('chevrolet-corvette-c3').archetype).toBe('v8-muscle');
    expect(resolveEngineProfile('chevrolet-corvette-c4').archetype).toBe('v8-muscle');
    expect(resolveEngineProfile('chevrolet-corvette-c5').archetype).toBe('v8-muscle');
    expect(resolveEngineProfile({ id: 'dodge-challenger', name: 'Dodge Challenger SRT' }).archetype).toBe('v8-muscle');

    expect(resolveEngineProfile('chevrolet-corvette-c6').archetype).toBe('v8-exotic');
    expect(resolveEngineProfile('chevrolet-corvette-c8').archetype).toBe('v8-exotic');

    expect(resolveEngineProfile('supercar-original').archetype).toBe('v10');
    expect(resolveEngineProfile('lamborghini-huracan-evo').archetype).toBe('v10');
    expect(resolveEngineProfile('unknown-custom-car').archetype).toBe('v10');
    expect(resolveEngineProfile(null).archetype).toBe('v10');

    const tesla = resolveEngineProfile('tesla-roadster-2026');
    expect(tesla).toBe(ELECTRIC_HYPERCAR_PROFILE);
    expect(tesla.archetype).toBe('v10');
    expect(tesla.electricWhine).toBeGreaterThan(0.8);
    expect(tesla.crackleIntensity).toBe(0);
  });

  it('exposes complete valid profiles for all 6 EngineArchetype values', () => {
    const archetypes: EngineArchetype[] = ['v12', 'flat6', 'i6-turbo', 'v8-muscle', 'v8-exotic', 'v10'];
    for (const arch of archetypes) {
      const p = getEngineProfile(arch);
      expect(p).toBe(ENGINE_PROFILES[arch]);
      expect(p.harmonics).toHaveLength(4);
      expect(p.redlineRpm).toBeGreaterThan(p.idleRpm);
      expect(p.filterMaxHz).toBeGreaterThan(p.filterMinHz);
    }
    // Pass-through returns exact object
    expect(resolveEngineProfile(ENGINE_PROFILES.flat6)).toBe(ENGINE_PROFILES.flat6);
  });

  it('normalizes arbitrary world surfaces safely into DriveSurface', () => {
    expect(normalizeDriveSurface('asphalt')).toBe('asphalt');
    expect(normalizeDriveSurface('concrete')).toBe('concrete');
    expect(normalizeDriveSurface('metal')).toBe('concrete');
    expect(normalizeDriveSurface('wood')).toBe('concrete');
    expect(normalizeDriveSurface('gravel')).toBe('gravel');
    expect(normalizeDriveSurface('dirt')).toBe('gravel');
    expect(normalizeDriveSurface('grass')).toBe('grass');
    expect(normalizeDriveSurface('unknown')).toBe('asphalt');
    expect(normalizeDriveSurface(undefined)).toBe('asphalt');
  });
});

// ---------------------------------------------------------------------------
// 2. Unsupported / Autoplay-Locked Safety
// ---------------------------------------------------------------------------

describe('SoundEngine graceful headless & autoplay behavior', () => {
  it('acts as a safe zero-throw no-op when Web Audio API is unavailable', async () => {
    const engine = new SoundEngine();
    expect(engine.getState().supported).toBe(false);
    expect(engine.getState().unlocked).toBe(false);
    expect(await engine.unlock()).toBe(false);

    // Every single method must execute cleanly without throwing
    expect(() => {
      engine.setMode('shop');
      engine.setCarProfile('lamborghini-aventador-lp700-4');
      engine.playCarSelect('ff1-toyota-supra-astra');
      engine.playPaintSpray();
      engine.playPartInstall();
      engine.playPartRemove();
      engine.playStockReset();
      engine.playLightSwitch();
      engine.playCameraSwoosh();
      engine.playUiClick();
      engine.setLiftMoving(true);
      engine.setMode('drive');
      engine.playIgnition();
      engine.updateDrive(makeDriveFrame());
      engine.playShift('up', 7800);
      engine.playShift('down', 4200);
      engine.setHorn(true);
      engine.playImpact({ gForce: 24, speedMps: 28, glassBreak: true, panelDetached: true });
      engine.playPartDetach();
      engine.updateScrape(0.8, 18);
      engine.playRepair();
      engine.playReset();
      engine.setPaused(true);
      engine.setPaused(false);
      engine.setMuted(true);
      engine.toggleMute();
      engine.setMasterVolume(0.5);
      engine.dispose();
    }).not.toThrow();
  });

  it('defers AudioContext creation until unlock() and deduplicates concurrent unlocks', async () => {
    let createdCount = 0;
    let mockCtx: MockAudioContext | null = null;
    const engine = new SoundEngine({
      audioContextFactory: () => {
        createdCount += 1;
        mockCtx = new MockAudioContext();
        return mockCtx as unknown as AudioContext;
      },
    });

    expect(engine.getState()).toMatchObject({ supported: true, unlocked: false, muted: false });
    expect(createdCount).toBe(0);

    // Pre-unlock settings are preserved and notify subscribers
    const snapshots: AudioStateSnapshot[] = [];
    const unsub = engine.subscribe(() => snapshots.push(engine.getState()));

    engine.setMasterVolume(0.6);
    engine.setCarProfile('porsche-911-gt3rs-astra-white');
    engine.setMode('shop');
    expect(createdCount).toBe(0);
    expect(snapshots).toHaveLength(1);
    expect(snapshots[0].volume).toBeCloseTo(0.6);

    // Concurrent unlocks create exactly one AudioContext
    const [r1, r2] = await Promise.all([engine.unlock(), engine.unlock()]);
    expect(r1).toBe(true);
    expect(r2).toBe(true);
    expect(createdCount).toBe(1);
    expect(mockCtx).not.toBeNull();
    expect(engine.getState().unlocked).toBe(true);
    expect(engine.getCarProfile().archetype).toBe('flat6');
    expect(engine.getMode()).toBe('shop');

    unsub();
    engine.dispose();
  });

  it('handles blocked AudioContext.resume() without throwing or rejecting', async () => {
    const mockCtx = new MockAudioContext();
    mockCtx.failResume = true;
    const engine = new SoundEngine({
      audioContextFactory: () => mockCtx as unknown as AudioContext,
    });

    const ok = await engine.unlock();
    expect(ok).toBe(false);
    expect(engine.getState().unlocked).toBe(false);

    // Succeeds on next user gesture
    mockCtx.failResume = false;
    expect(await engine.unlock()).toBe(true);
    expect(engine.getState().unlocked).toBe(true);

    engine.dispose();
  });
});

// ---------------------------------------------------------------------------
// 3. Full Audio Graph, Limiter, Volume/Mute/Pause & Mode Crossfades
// ---------------------------------------------------------------------------

describe('SoundEngine master chain, state controls & lifecycle', () => {
  it('constructs a master soft limiter, noise bank, and handles mute/volume/pause cleanly', async () => {
    const mockCtx = new MockAudioContext();
    const engine = new SoundEngine({
      audioContextFactory: () => mockCtx as unknown as AudioContext,
      initialVolume: 0.8,
    });

    await engine.unlock();

    // Master soft limiter + 4 shared noise buffers (white, pink, brown, crackle)
    expect(mockCtx.compressors.length).toBeGreaterThanOrEqual(1);
    expect(mockCtx.compressors[0].ratio.value).toBeGreaterThanOrEqual(8);
    expect(mockCtx.buffers).toHaveLength(4);

    // First gain node created in buildAudioGraph is masterGain connected to destination
    const masterGain = mockCtx.gains[0];
    expect(masterGain.connections).toContain(mockCtx.destination);
    expect(masterGain.gain.value).toBeCloseTo(0.8);

    // Mute / unmute & volume clamping
    expect(engine.toggleMute()).toBe(true);
    expect(engine.getState().muted).toBe(true);
    expect(masterGain.gain.value).toBe(0);

    expect(engine.toggleMute()).toBe(false);
    expect(masterGain.gain.value).toBeCloseTo(0.8);

    engine.setMasterVolume(2.5);
    expect(engine.getState().volume).toBe(1);
    engine.setMasterVolume(-1);
    expect(engine.getState().volume).toBe(0);
    engine.setMasterVolume(Number.NaN);
    expect(engine.getState().volume).toBe(0);
    engine.setMasterVolume(0.65);
    expect(engine.getState().volume).toBeCloseTo(0.65);

    // Pause silences master output and unpause restores it
    engine.setPaused(true);
    expect(masterGain.gain.value).toBe(0);
    engine.setPaused(false);
    expect(masterGain.gain.value).toBeCloseTo(0.65);

    // Dispose stops all continuous sources, closes AudioContext, and guards subsequent calls
    const listener = vi.fn();
    engine.subscribe(listener);
    engine.dispose();

    expect(mockCtx.closeCalls).toBe(1);
    expect(engine.getState().unlocked).toBe(false);
    expect(listener).toHaveBeenCalledTimes(1);

    // Double dispose and post-dispose calls are safe no-ops
    expect(() => {
      engine.dispose();
      engine.updateDrive(makeDriveFrame());
      engine.playImpact({ gForce: 30, speedMps: 30 });
      engine.playUiClick();
    }).not.toThrow();
    expect(mockCtx.closeCalls).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// 4. Driving Synthesis: Engine, Turbo BOV, Crackles, Foley, Surfaces & Crashes
// ---------------------------------------------------------------------------

describe('Driving, Engine, Foley & Crash synthesis', () => {
  it('synthesizes continuous engine sweeps, turbo BOV flutter, lift-off crackles, shifts, and ignition without NaN/clicks', async () => {
    const mockCtx = new MockAudioContext();
    const engine = new SoundEngine({
      audioContextFactory: () => mockCtx as unknown as AudioContext,
    });
    await engine.unlock();
    engine.setCarProfile('ff1-toyota-supra-astra');
    engine.setMode('drive');

    const oscBeforeIgnition = mockCtx.oscillators.length;
    engine.playIgnition();
    expect(mockCtx.oscillators.length).toBeGreaterThan(oscBeforeIgnition);

    // Accelerate hard under boost
    mockCtx.advanceTime(0.4);
    for (let i = 0; i < 15; i++) {
      mockCtx.advanceTime(1 / 60);
      engine.updateDrive(
        makeDriveFrame({
          rpm: 2400 + i * 320,
          idleRpm: 850,
          redlineRpm: 7600,
          throttle: 1.0,
          turboBoost: 0.9,
          speedMps: 18 + i * 2,
          cameraMode: i % 2 === 0 ? 'hood' : 'chase',
        }),
      );
    }

    // Abrupt lift-off at high boost should fire BOV flutter buffer sources
    const sourcesBeforeLift = mockCtx.bufferSources.length;
    mockCtx.advanceTime(0.05);
    engine.updateDrive(
      makeDriveFrame({
        rpm: 6800,
        idleRpm: 850,
        redlineRpm: 7600,
        throttle: 0.0,
        turboBoost: 0.1,
        speedMps: 45,
      }),
    );
    expect(mockCtx.bufferSources.length).toBeGreaterThan(sourcesBeforeLift);

    // High-RPM deceleration triggers overrun crackles
    const sourcesBeforeDecel = mockCtx.bufferSources.length;
    for (let i = 0; i < 20; i++) {
      mockCtx.advanceTime(0.03);
      engine.updateDrive(
        makeDriveFrame({
          dt: 0.03,
          rpm: 6600 - i * 120,
          idleRpm: 850,
          redlineRpm: 7600,
          throttle: 0,
          turboBoost: 0,
          speedMps: 40,
        }),
      );
    }
    expect(mockCtx.bufferSources.length).toBeGreaterThan(sourcesBeforeDecel);

    // Upshift & downshift transients
    const oscBeforeShift = mockCtx.oscillators.length;
    mockCtx.advanceTime(0.35);
    engine.playShift('up', 7300);
    engine.playShift('down', 4800);
    expect(mockCtx.oscillators.length).toBeGreaterThan(oscBeforeShift);

    // Heavily damaged engine misfire sputter
    for (let i = 0; i < 25; i++) {
      mockCtx.advanceTime(0.03);
      engine.updateDrive(
        makeDriveFrame({
          dt: 0.03,
          rpm: 1100,
          throttle: 0.1,
          engineHealth: 0.15,
        }),
      );
    }

    // Switch through all archetypes including electric Tesla Roadster
    for (const carId of [
      'lamborghini-aventador-lp700-4',
      'porsche-911-gt3rs-astra-white',
      'chevrolet-corvette-c3',
      'chevrolet-corvette-c8',
      'supercar-original',
      'tesla-roadster-2026',
    ]) {
      engine.setCarProfile(carId);
      mockCtx.advanceTime(0.05);
      engine.playIgnition();
      engine.updateDrive(makeDriveFrame({ rpm: 7200, throttle: 0.9, speedMps: 52 }));
      engine.playShift('up', 7200);
    }

    engine.dispose();
  });

  it('survives garbage / NaN / Infinity telemetry values without throwing', async () => {
    const mockCtx = new MockAudioContext();
    const engine = new SoundEngine({
      audioContextFactory: () => mockCtx as unknown as AudioContext,
    });
    await engine.unlock();
    engine.setMode('drive');

    expect(() => {
      engine.updateDrive({
        dt: Number.NaN,
        speedMps: Number.POSITIVE_INFINITY,
        rpm: Number.NaN,
        idleRpm: -500,
        redlineRpm: Number.NEGATIVE_INFINITY,
        gear: Number.NaN,
        throttle: Number.POSITIVE_INFINITY,
        brake: -99,
        handbrake: true,
        turboBoost: Number.NaN,
        slipRatio: Number.POSITIVE_INFINITY,
        wheelLoad: Number.NaN,
        surface: 'asphalt',
        cameraMode: 'bumper',
        airborne: false,
        hornActive: true,
        scrapeIntensity: Number.POSITIVE_INFINITY,
        engineHealth: Number.NaN,
      });
      engine.playShift('up', Number.NaN);
      engine.playImpact({ gForce: Number.NaN, speedMps: Number.POSITIVE_INFINITY });
      engine.updateScrape(Number.NaN, Number.NEGATIVE_INFINITY);
    }).not.toThrow();

    engine.dispose();
  });

  it('drives tire screech, surface details (gravel pebbles, concrete joints), wind, horn, and airborne touchdown', async () => {
    const mockCtx = new MockAudioContext();
    const engine = new SoundEngine({
      audioContextFactory: () => mockCtx as unknown as AudioContext,
    });
    await engine.unlock();
    engine.setMode('drive');

    // Gravel driving spawns pebble pings
    const oscBeforeGravel = mockCtx.oscillators.length;
    for (let i = 0; i < 15; i++) {
      mockCtx.advanceTime(0.05);
      engine.updateDrive(
        makeDriveFrame({
          dt: 0.05,
          speedMps: 22,
          surface: 'gravel',
          slipRatio: 0.65,
        }),
      );
    }
    expect(mockCtx.oscillators.length).toBeGreaterThan(oscBeforeGravel);

    // Concrete driving spawns expansion joint thumps after >14.5m traveled
    const oscBeforeConcrete = mockCtx.oscillators.length;
    for (let i = 0; i < 20; i++) {
      mockCtx.advanceTime(0.05);
      engine.updateDrive(
        makeDriveFrame({
          dt: 0.05,
          speedMps: 25,
          surface: 'concrete',
          brake: 0.8,
        }),
      );
    }
    expect(mockCtx.oscillators.length).toBeGreaterThan(oscBeforeConcrete);

    // Grass + handbrake drift + horn toggle
    engine.updateDrive(
      makeDriveFrame({
        surface: 'grass',
        handbrake: true,
        hornActive: true,
        cameraMode: 'bumper',
      }),
    );
    engine.setHorn(false);

    // Airborne jump followed by landing thump
    const oscBeforeLanding = mockCtx.oscillators.length;
    for (let i = 0; i < 8; i++) {
      mockCtx.advanceTime(0.04);
      engine.updateDrive(makeDriveFrame({ dt: 0.04, airborne: true, wheelLoad: 0 }));
    }
    mockCtx.advanceTime(0.04);
    engine.updateDrive(makeDriveFrame({ dt: 0.04, airborne: false, wheelLoad: 1.2 }));
    expect(mockCtx.oscillators.length).toBeGreaterThan(oscBeforeLanding);

    engine.dispose();
  });

  it('triggers layered crash impacts, glass shatter at >=18G, part detach, continuous scrape, repair & reset', async () => {
    const mockCtx = new MockAudioContext();
    const engine = new SoundEngine({
      audioContextFactory: () => mockCtx as unknown as AudioContext,
    });
    await engine.unlock();
    engine.setMode('drive');

    // Tiny sub-threshold bump produces no crash nodes
    const beforeTiny = mockCtx.oscillators.length;
    engine.playImpact({ gForce: 0.2, speedMps: 0.3 });
    expect(mockCtx.oscillators.length).toBe(beforeTiny);

    // Light fender bender (no glass shatter)
    const beforeLight = mockCtx.oscillators.length;
    engine.playImpact({ gForce: 7, speedMps: 9, metallic: true });
    const lightOscAdded = mockCtx.oscillators.length - beforeLight;
    expect(lightOscAdded).toBeGreaterThan(0);

    // Duplicate same-millisecond contact is rate-limited
    const beforeDup = mockCtx.oscillators.length;
    engine.playImpact({ gForce: 7, speedMps: 9 });
    expect(mockCtx.oscillators.length).toBe(beforeDup);

    // Heavy >=18G crash triggers glass shatter + detached panel tumble
    mockCtx.advanceTime(0.2);
    const beforeHeavy = mockCtx.oscillators.length;
    engine.playImpact({ gForce: 24, speedMps: 31, panelDetached: true });
    const heavyOscAdded = mockCtx.oscillators.length - beforeHeavy;
    expect(heavyOscAdded).toBeGreaterThan(lightOscAdded + 8);

    // Continuous scrape on & off
    engine.updateScrape(0.85, 22);
    engine.updateScrape(0, 0);

    // Repair & Reset audio cues
    const beforeRepair = mockCtx.oscillators.length;
    engine.playRepair();
    expect(mockCtx.oscillators.length).toBeGreaterThan(beforeRepair);

    const beforeReset = mockCtx.oscillators.length;
    engine.playReset();
    expect(mockCtx.oscillators.length).toBeGreaterThan(beforeReset);

    engine.dispose();
  });

  it('plays all garage, mechanics shop & UI foley cues and updates profile on playCarSelect', async () => {
    const mockCtx = new MockAudioContext();
    const engine = new SoundEngine({
      audioContextFactory: () => mockCtx as unknown as AudioContext,
    });
    await engine.unlock();
    engine.setMode('shop');

    const initialOsc = mockCtx.oscillators.length;
    const initialBuf = mockCtx.bufferSources.length;

    engine.playPaintSpray();
    mockCtx.advanceTime(0.15);
    engine.playPartInstall();
    engine.playPartRemove();
    engine.playStockReset();
    engine.playLightSwitch();
    engine.playCameraSwoosh();
    engine.setLiftMoving(true);
    engine.setLiftMoving(false);
    mockCtx.advanceTime(0.05);
    engine.playUiClick();

    // Car select updates active profile and fires bay door rumble + engine rev preview
    engine.playCarSelect('lamborghini-aventador-lp700-4');
    expect(engine.getCarProfile().archetype).toBe('v12');

    expect(mockCtx.oscillators.length).toBeGreaterThan(initialOsc + 10);
    expect(mockCtx.bufferSources.length).toBeGreaterThan(initialBuf + 3);

    // Leaving shop to idle cleanly silences shop ambience
    engine.setMode('idle');
    expect(engine.getMode()).toBe('idle');

    engine.dispose();
  });
});
