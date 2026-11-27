import { describe, expect, it, vi } from 'vitest';
import {
  ELECTRIC_HYPERCAR_PROFILE,
  ENGINE_PROFILES,
  ENGINE_WORKLET_NAME,
  SoundEngine,
  createExhaustOutdoorIR,
  createPhysicalEngineProbe,
  createTunnelReverbIR,
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

class MockConvolverNode extends MockAudioNode {
  buffer: MockAudioBuffer | null = null;
  normalize = true;
}

class MockDelayNode extends MockAudioNode {
  readonly delayTime = new MockAudioParam(0);
}

class MockPeriodicWave {
  constructor(
    readonly real: Float32Array,
    readonly imag: Float32Array,
  ) {}
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
  periodicWave: MockPeriodicWave | null = null;

  setPeriodicWave(wave: MockPeriodicWave): void {
    this.periodicWave = wave;
  }
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
  readonly convolvers: MockConvolverNode[] = [];
  readonly delays: MockDelayNode[] = [];
  readonly periodicWaves: MockPeriodicWave[] = [];
  readonly bufferSources: MockBufferSourceNode[] = [];
  readonly buffers: MockAudioBuffer[] = [];

  audioWorklet?: { addModule: (url: string) => Promise<void> };

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

  createConvolver(): MockConvolverNode {
    const n = new MockConvolverNode();
    this.convolvers.push(n);
    return n;
  }

  createDelay(): MockDelayNode {
    const n = new MockDelayNode();
    this.delays.push(n);
    return n;
  }

  createPeriodicWave(real: Float32Array, imag: Float32Array): MockPeriodicWave {
    const w = new MockPeriodicWave(real, imag);
    this.periodicWaves.push(w);
    return w;
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
    inTunnel: false,
    ...overrides,
  };
}

function measureSignal(buf: Float32Array): { rms: number; peak: number; dc: number; allFinite: boolean } {
  let sum = 0;
  let sq = 0;
  let peak = 0;
  let allFinite = true;
  for (let i = 0; i < buf.length; i++) {
    const v = buf[i];
    if (!Number.isFinite(v)) {
      allFinite = false;
      continue;
    }
    sum += v;
    sq += v * v;
    const a = Math.abs(v);
    if (a > peak) peak = a;
  }
  return {
    rms: Math.sqrt(sq / Math.max(1, buf.length)),
    peak,
    dc: sum / Math.max(1, buf.length),
    allFinite,
  };
}

// ---------------------------------------------------------------------------
// 1. Engine Profile Resolution & Surface Normalization
// ---------------------------------------------------------------------------

describe('engineProfiles & surface helpers', () => {
  it('maps every car in the Blend Garage fleet to its intended acoustic & physical 4-stroke profile', () => {
    const aventador = resolveEngineProfile('lamborghini-aventador-lp700-4');
    expect(aventador.archetype).toBe('v12');
    expect(aventador.redlineRpm).toBe(8500);
    expect(aventador.physical.cylinders).toBe(12);
    expect(aventador.physical.firingAnglesDeg).toHaveLength(12);

    const gt3 = resolveEngineProfile('porsche-911-gt3rs-astra-white');
    expect(gt3.archetype).toBe('flat6');
    expect(gt3.redlineRpm).toBe(9000);
    expect(gt3.physical.cylinders).toBe(6);
    expect(gt3.physical.headerDelayLMs).not.toBe(gt3.physical.headerDelayRMs);

    const supraAstra = resolveEngineProfile('ff1-toyota-supra-astra');
    const supraNeon = resolveEngineProfile('ff1-toyota-supra-gemini-neon');
    expect(supraAstra.archetype).toBe('i6-turbo');
    expect(supraNeon.archetype).toBe('i6-turbo');
    expect(supraAstra.hasTurbo).toBe(true);
    expect(supraAstra.turboWhineGain).toBeGreaterThan(0.5);
    expect(supraAstra.bovIntensity).toBeGreaterThan(0.5);

    // Cross-plane V8 muscle uses authentic L-R-L-L-R-L-R-R uneven bank pairing!
    const c3 = resolveEngineProfile('chevrolet-corvette-c3');
    expect(c3.archetype).toBe('v8-muscle');
    expect(c3.physical.cylinderBanks).toEqual([0, 1, 0, 0, 1, 0, 1, 1]);
    expect(resolveEngineProfile('chevrolet-corvette-c4').archetype).toBe('v8-muscle');
    expect(resolveEngineProfile('chevrolet-corvette-c5').archetype).toBe('v8-muscle');
    expect(resolveEngineProfile({ id: 'dodge-challenger', name: 'Dodge Challenger SRT' }).archetype).toBe('v8-muscle');

    // Exotic flat-plane V8 strictly alternates L-R-L-R-L-R-L-R
    const c8 = resolveEngineProfile('chevrolet-corvette-c8');
    expect(c8.archetype).toBe('v8-exotic');
    expect(c8.physical.cylinderBanks).toEqual([0, 1, 0, 1, 0, 1, 0, 1]);
    expect(resolveEngineProfile('chevrolet-corvette-c6').archetype).toBe('v8-exotic');

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
      expect(p.physical.firingAnglesDeg).toHaveLength(p.physical.cylinders);
      expect(p.physical.cylinderBanks).toHaveLength(p.physical.cylinders);
      expect(p.redlineRpm).toBeGreaterThan(p.idleRpm);
      expect(p.filterMaxHz).toBeGreaterThan(p.filterMinHz);
    }
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
// 2. 48 kHz Physical 4-Stroke Combustion + Exhaust Waveguide DSP Verification
// ---------------------------------------------------------------------------

describe('48 kHz Physical 4-Stroke Engine Worklet DSP Kernel', () => {
  it('synthesizes stable, finite, zero-DC, dynamic combustion & waveguide audio for every archetype + EV', () => {
    const profiles = [
      ENGINE_PROFILES.v12,
      ENGINE_PROFILES.flat6,
      ENGINE_PROFILES['i6-turbo'],
      ENGINE_PROFILES['v8-muscle'],
      ENGINE_PROFILES['v8-exotic'],
      ENGINE_PROFILES.v10,
      ELECTRIC_HYPERCAR_PROFILE,
    ];

    for (const profile of profiles) {
      const probe = createPhysicalEngineProbe(48000);
      probe.setProfile(profile);

      // Warm idle
      probe.setFrame({
        active: true,
        rpm: profile.idleRpm,
        idleRpm: profile.idleRpm,
        redlineRpm: profile.redlineRpm,
        throttle: 0.02,
        turboBoost: 0,
        speedMps: 0,
        engineHealth: 1,
        cameraBrightness: 1,
        cameraIntakeBoost: 1,
        cameraLevel: 1,
      });
      const idleOut = probe.render(12000); // 250ms
      const idleStats = measureSignal(idleOut.left);
      expect(idleStats.allFinite).toBe(true);
      expect(idleStats.peak).toBeLessThanOrEqual(1.0);
      expect(Math.abs(idleStats.dc)).toBeLessThan(0.03);
      expect(idleStats.rms).toBeGreaterThan(0.005);

      // Wide-open throttle roar at 75% redline must have stronger energy than closed-throttle idle
      probe.setFrame({
        active: true,
        rpm: profile.idleRpm + (profile.redlineRpm - profile.idleRpm) * 0.75,
        idleRpm: profile.idleRpm,
        redlineRpm: profile.redlineRpm,
        throttle: 1.0,
        turboBoost: profile.hasTurbo ? 0.9 : 0,
        speedMps: 58,
        engineHealth: 1,
        cameraBrightness: 1.15,
        cameraIntakeBoost: 1.35,
        cameraLevel: 1,
      });
      const wotOut = probe.render(12000);
      const wotStats = measureSignal(wotOut.left);
      expect(wotStats.allFinite).toBe(true);
      expect(wotStats.peak).toBeLessThanOrEqual(1.0);
      expect(Math.abs(wotStats.dc)).toBeLessThan(0.03);
      expect(wotStats.rms).toBeGreaterThan(idleStats.rms * 1.15);
    }
  });

  it('produces authentic stereo bank asymmetry for cross-plane V8 (L-R-L-L-R-L-R-R) and handles ignition, shifts, crackles & rev preview', () => {
    const probe = createPhysicalEngineProbe(48000);
    probe.setProfile(ENGINE_PROFILES['v8-muscle']);

    // Showroom rev preview works even while continuous driving active === false
    probe.triggerRevPreview(ENGINE_PROFILES['v8-muscle']);
    const preview = probe.render(16000);
    const previewStats = measureSignal(preview.left);
    expect(previewStats.allFinite).toBe(true);
    expect(previewStats.rms).toBeGreaterThan(0.02);

    // Measure genuine stereo L/R bank width on cross-plane V8 idle
    probe.setFrame({
      active: true,
      rpm: 720,
      idleRpm: 700,
      redlineRpm: 6500,
      throttle: 0.05,
      turboBoost: 0,
      speedMps: 0,
      engineHealth: 1,
      cameraBrightness: 1,
      cameraIntakeBoost: 1,
      cameraLevel: 1,
    });
    const v8Idle = probe.render(14000);
    const diff = new Float32Array(v8Idle.left.length);
    for (let i = 0; i < diff.length; i++) diff[i] = v8Idle.left[i] - v8Idle.right[i];
    expect(measureSignal(diff).rms).toBeGreaterThan(0.008);

    // Ignition crank + upshift cut + downshift blip + high-RPM overrun crackles + damaged misfire
    probe.triggerIgnition();
    const crank = probe.render(18000);
    expect(measureSignal(crank.left).allFinite).toBe(true);
    expect(measureSignal(crank.left).rms).toBeGreaterThan(0.02);

    probe.setFrame({
      active: true,
      rpm: 5800,
      idleRpm: 700,
      redlineRpm: 6500,
      throttle: 0.0,
      turboBoost: 0,
      speedMps: 45,
      engineHealth: 0.25,
      cameraBrightness: 1,
      cameraIntakeBoost: 1,
      cameraLevel: 1,
    });
    probe.triggerShift('up', 5800);
    probe.triggerShift('down', 4400);
    const overrun = probe.render(24000);
    const overrunStats = measureSignal(overrun.left);
    expect(overrunStats.allFinite).toBe(true);
    expect(overrunStats.peak).toBeLessThanOrEqual(1.0);
    expect(overrunStats.rms).toBeGreaterThan(0.01);
  });
});

// ---------------------------------------------------------------------------
// 3. Procedural Acoustic Impulse Responses (Outdoor Cabinet + Concrete Tunnel)
// ---------------------------------------------------------------------------

describe('Procedural Convolver Impulse Responses', () => {
  it('generates decaying stereo outdoor exhaust cabinet and concrete tunnel impulse responses', () => {
    const mockCtx = new MockAudioContext();
    const outdoor = createExhaustOutdoorIR(mockCtx as unknown as BaseAudioContext);
    const tunnel = createTunnelReverbIR(mockCtx as unknown as BaseAudioContext);

    expect(outdoor.numberOfChannels).toBe(2);
    expect(tunnel.numberOfChannels).toBe(2);
    expect(tunnel.length).toBeGreaterThan(outdoor.length * 5);

    const outL = measureSignal(outdoor.getChannelData(0));
    const tunL = measureSignal(tunnel.getChannelData(0));
    expect(outL.allFinite).toBe(true);
    expect(tunL.allFinite).toBe(true);
    expect(outL.rms).toBeGreaterThan(0.01);
    expect(tunL.rms).toBeGreaterThan(0.01);

    // Early energy must exceed late tail energy (natural acoustic decay)
    const tunData = tunnel.getChannelData(0);
    const earlyRms = measureSignal(tunData.subarray(0, Math.floor(tunData.length * 0.2))).rms;
    const lateRms = measureSignal(tunData.subarray(Math.floor(tunData.length * 0.8))).rms;
    expect(earlyRms).toBeGreaterThan(lateRms * 2);
  });
});

// ---------------------------------------------------------------------------
// 4. Unsupported / Autoplay-Locked Safety & AudioWorklet Blob URL Loading
// ---------------------------------------------------------------------------

describe('SoundEngine graceful headless, autoplay & AudioWorklet lifecycle', () => {
  it('acts as a safe zero-throw no-op when Web Audio API is unavailable', async () => {
    const engine = new SoundEngine();
    expect(engine.getState().supported).toBe(false);
    expect(engine.getState().unlocked).toBe(false);
    expect(await engine.unlock()).toBe(false);
    expect(engine.isUsingEngineWorklet()).toBe(false);

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
      engine.updateDrive(makeDriveFrame({ inTunnel: true }));
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

    const snapshots: AudioStateSnapshot[] = [];
    const unsub = engine.subscribe(() => snapshots.push(engine.getState()));

    engine.setMasterVolume(0.6);
    engine.setCarProfile('porsche-911-gt3rs-astra-white');
    engine.setMode('shop');
    expect(createdCount).toBe(0);
    expect(snapshots).toHaveLength(1);
    expect(snapshots[0].volume).toBeCloseTo(0.6);

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

  it('loads the 48 kHz inline-Blob AudioWorklet when supported and forwards profile/frame/transients cleanly', async () => {
    const addedModules: string[] = [];
    const postedMessages: unknown[] = [];
    const mockCtx = new MockAudioContext();
    mockCtx.audioWorklet = {
      addModule: async (url: string) => {
        addedModules.push(url);
      },
    };

    class MockWorkletNode extends MockAudioNode {
      readonly port = {
        postMessage: (msg: unknown) => {
          postedMessages.push(msg);
        },
      };
      constructor(
        _ctx: AudioContext,
        readonly name: string,
      ) {
        super();
      }
    }

    const origWorkletNode = (globalThis as Record<string, unknown>).AudioWorkletNode;
    (globalThis as Record<string, unknown>).AudioWorkletNode = MockWorkletNode;

    try {
      const engine = new SoundEngine({
        audioContextFactory: () => mockCtx as unknown as AudioContext,
      });

      expect(await engine.unlock()).toBe(true);
      expect(engine.isUsingEngineWorklet()).toBe(true);
      expect(addedModules).toHaveLength(1);
      expect(addedModules[0]).toMatch(/^blob:/);

      engine.setCarProfile('chevrolet-corvette-c3');
      engine.setMode('drive');
      engine.playIgnition();
      engine.updateDrive(makeDriveFrame({ rpm: 4200, throttle: 0.9, inTunnel: true }));
      engine.playShift('up', 6100);
      engine.playShift('down', 4200);
      engine.playCarSelect('lamborghini-aventador-lp700-4');

      const msgTypes = postedMessages.map((m) => (m as { type?: string }).type);
      expect(msgTypes).toContain('profile');
      expect(msgTypes).toContain('frame');
      expect(msgTypes).toContain('ignition');
      expect(msgTypes).toContain('shift');
      expect(msgTypes).toContain('revPreview');

      // Worklet name matches exported constant
      expect(ENGINE_WORKLET_NAME).toBe('blend-garage-engine-processor');

      engine.dispose();
      expect(postedMessages.map((m) => (m as { type?: string }).type)).toContain('dispose');
      expect(engine.isUsingEngineWorklet()).toBe(false);
    } finally {
      if (origWorkletNode === undefined) {
        delete (globalThis as Record<string, unknown>).AudioWorkletNode;
      } else {
        (globalThis as Record<string, unknown>).AudioWorkletNode = origWorkletNode;
      }
    }
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

    mockCtx.failResume = false;
    expect(await engine.unlock()).toBe(true);
    expect(engine.getState().unlocked).toBe(true);

    engine.dispose();
  });
});

// ---------------------------------------------------------------------------
// 5. Master Chain, Limiter, Convolver Sends, Volume/Mute/Pause & Lifecycle
// ---------------------------------------------------------------------------

describe('SoundEngine master chain, acoustic convolvers & state controls', () => {
  it('constructs limiter, outdoor cabinet + tunnel convolvers, fallback PeriodicWave/waveguide, and modulates tunnel send', async () => {
    const mockCtx = new MockAudioContext();
    const engine = new SoundEngine({
      audioContextFactory: () => mockCtx as unknown as AudioContext,
      initialVolume: 0.8,
    });

    await engine.unlock();

    // Master soft limiter + both ConvolverNodes (tunnel reverb + outdoor exhaust cabinet)
    expect(mockCtx.compressors.length).toBeGreaterThanOrEqual(1);
    expect(mockCtx.compressors[0].ratio.value).toBeGreaterThanOrEqual(8);
    expect(mockCtx.convolvers).toHaveLength(2);
    // Fallback PeriodicWave combustion table & exhaust waveguide DelayNode created
    expect(mockCtx.periodicWaves.length).toBeGreaterThanOrEqual(1);
    expect(mockCtx.delays.length).toBeGreaterThanOrEqual(1);

    const masterGain = mockCtx.gains[0];
    expect(masterGain.connections).toContain(mockCtx.destination);
    expect(masterGain.gain.value).toBeCloseTo(0.8);

    // Find the tunnelSendGain (the gain node connected directly to the first convolver)
    const tunnelConvolver = mockCtx.convolvers[0];
    const tunnelSendGain = mockCtx.gains.find((g) => g.connections.includes(tunnelConvolver));
    expect(tunnelSendGain).toBeDefined();
    expect(tunnelSendGain?.gain.value).toBe(0);

    // Entering tunnel in drive mode smoothly raises tunnel reverb send; exiting drops it back to 0
    engine.setMode('drive');
    engine.updateDrive(makeDriveFrame({ inTunnel: true }));
    expect(tunnelSendGain!.gain.value).toBeGreaterThan(0.4);

    engine.updateDrive(makeDriveFrame({ inTunnel: false }));
    expect(tunnelSendGain!.gain.value).toBe(0);

    // Leaving drive mode while inside tunnel also resets tunnel send cleanly to 0
    engine.updateDrive(makeDriveFrame({ inTunnel: true }));
    expect(tunnelSendGain!.gain.value).toBeGreaterThan(0.4);
    engine.setMode('shop');
    expect(tunnelSendGain!.gain.value).toBe(0);

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

    engine.setPaused(true);
    expect(masterGain.gain.value).toBe(0);
    engine.setPaused(false);
    expect(masterGain.gain.value).toBeCloseTo(0.65);

    const listener = vi.fn();
    engine.subscribe(listener);
    engine.dispose();

    expect(mockCtx.closeCalls).toBe(1);
    expect(engine.getState().unlocked).toBe(false);
    expect(listener).toHaveBeenCalledTimes(1);

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
// 6. Driving Synthesis: Engine, Turbo BOV, Crackles, Foley, Surfaces & Crashes
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

    // Abrupt lift-off at high boost fires BOV flutter buffer sources
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
        inTunnel: true,
      });
      engine.playShift('up', Number.NaN);
      engine.playImpact({ gForce: Number.NaN, speedMps: Number.POSITIVE_INFINITY });
      engine.updateScrape(Number.NaN, Number.NEGATIVE_INFINITY);
    }).not.toThrow();

    engine.dispose();
  });

  it('drives smooth scrubbed-rubber tire screech, surface details, wind, horn, and airborne touchdown', async () => {
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

    // Asphalt drift, grass & horn toggle
    engine.updateDrive(
      makeDriveFrame({
        surface: 'asphalt',
        handbrake: true,
        slipRatio: 0.92,
        speedMps: 30,
      }),
    );
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

  it('produces loud, responsive resonant tire screech on hard corners, launches, braking, and handbrake drifts with surface scaling', async () => {
    const mockCtx = new MockAudioContext();
    const engine = new SoundEngine({
      audioContextFactory: () => mockCtx as unknown as AudioContext,
    });
    await engine.unlock();
    engine.setMode('drive');

    // Verify both tight high-Q resonant rubber formants (Q >= 14) exist
    const highQFormants = mockCtx.filters.filter((f) => f.type === 'bandpass' && f.Q.value >= 14);
    expect(highQFormants.length).toBeGreaterThanOrEqual(2);

    // Locate screechGain (the gain fed by the 4100 Hz lowpass of the tire screech chain)
    const screechLp = mockCtx.filters.find((f) => f.type === 'lowpass' && f.frequency.value === 4100);
    expect(screechLp).toBeDefined();
    const screechGain = screechLp?.connections[0] as MockGainNode | undefined;
    expect(screechGain).toBeDefined();

    // Silent when stopped or below threshold
    engine.updateDrive(makeDriveFrame({ speedMps: 0.3, slipRatio: 0.05, handbrake: false }));
    expect(screechGain!.gain.value).toBe(0);

    // Responsive onset on low-speed launch / moderate corner slip (> 0.12 slip, > 0.9 m/s)
    engine.updateDrive(makeDriveFrame({ speedMps: 4.5, slipRatio: 0.32, handbrake: false, surface: 'asphalt' }));
    const cornerLevel = screechGain!.gain.value;
    expect(cornerLevel).toBeGreaterThan(0.14);

    // Full handbrake drift on asphalt cuts cleanly through engine (>= 0.62)
    engine.updateDrive(makeDriveFrame({ speedMps: 22, slipRatio: 0.2, handbrake: true, surface: 'asphalt' }));
    const asphaltDrift = screechGain!.gain.value;
    expect(asphaltDrift).toBeGreaterThanOrEqual(0.62);
    expect(asphaltDrift).toBeLessThanOrEqual(0.85);

    // Concrete is slightly louder; gravel & grass attenuate properly; airborne mutes to 0
    engine.updateDrive(makeDriveFrame({ speedMps: 22, slipRatio: 0.2, handbrake: true, surface: 'concrete' }));
    const concreteDrift = screechGain!.gain.value;
    expect(concreteDrift).toBeGreaterThan(asphaltDrift);

    engine.updateDrive(makeDriveFrame({ speedMps: 22, slipRatio: 0.2, handbrake: true, surface: 'gravel' }));
    const gravelDrift = screechGain!.gain.value;
    expect(gravelDrift).toBeGreaterThan(0.08);
    expect(gravelDrift).toBeLessThan(asphaltDrift * 0.35);

    engine.updateDrive(makeDriveFrame({ speedMps: 22, slipRatio: 0.2, handbrake: true, surface: 'grass' }));
    const grassDrift = screechGain!.gain.value;
    expect(grassDrift).toBeGreaterThan(0.03);
    expect(grassDrift).toBeLessThan(gravelDrift);

    engine.updateDrive(makeDriveFrame({ speedMps: 22, slipRatio: 0.9, handbrake: true, airborne: true }));
    expect(screechGain!.gain.value).toBe(0);

    engine.dispose();
  });

  it('triggers heavy crash impacts (sub-slam, buckling groan, staggered glass shatter), part detach, scrape, repair & reset', async () => {
    const mockCtx = new MockAudioContext();
    const engine = new SoundEngine({
      audioContextFactory: () => mockCtx as unknown as AudioContext,
    });
    await engine.unlock();
    engine.setMode('drive');

    const beforeTiny = mockCtx.oscillators.length;
    engine.playImpact({ gForce: 0.2, speedMps: 0.3 });
    expect(mockCtx.oscillators.length).toBe(beforeTiny);

    const beforeLight = mockCtx.oscillators.length;
    engine.playImpact({ gForce: 7, speedMps: 9, metallic: true });
    const lightOscAdded = mockCtx.oscillators.length - beforeLight;
    expect(lightOscAdded).toBeGreaterThan(0);

    // Duplicate same-millisecond contact is rate-limited
    const beforeDup = mockCtx.oscillators.length;
    engine.playImpact({ gForce: 7, speedMps: 9 });
    expect(mockCtx.oscillators.length).toBe(beforeDup);

    // Heavy >=18G crash triggers buckling groan + staggered glass shatter + detached panel tumble
    mockCtx.advanceTime(0.2);
    const beforeHeavy = mockCtx.oscillators.length;
    engine.playImpact({ gForce: 28, speedMps: 34, panelDetached: true });
    const heavyOscAdded = mockCtx.oscillators.length - beforeHeavy;
    expect(heavyOscAdded).toBeGreaterThan(lightOscAdded + 10);

    engine.updateScrape(0.85, 22);
    engine.updateScrape(0, 0);

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

    engine.playCarSelect('lamborghini-aventador-lp700-4');
    expect(engine.getCarProfile().archetype).toBe('v12');

    expect(mockCtx.oscillators.length).toBeGreaterThan(initialOsc + 10);
    expect(mockCtx.bufferSources.length).toBeGreaterThan(initialBuf + 3);

    engine.setMode('idle');
    expect(engine.getMode()).toBe('idle');

    engine.dispose();
  });
});
