import {
  clampFinite,
  createCombustionCurve,
  createLoopingNoise,
  lerpClamped,
  safeExpRamp,
  safeLinearRamp,
  safeSetTarget,
  safeSetValue,
  scheduleStop,
  type AudioNoiseBank,
} from './dsp';
import { ENGINE_PROFILES } from './engineProfiles';
import {
  serializeWorkletProfile,
  tryCreateEngineWorkletNode,
  type EngineWorkletFramePayload,
} from './engineWorklet';
import { createExhaustOutdoorIR, tryCreateConvolver } from './reverb';
import type { DriveAudioFrame, EngineAcousticProfile, ShiftDirection } from './types';

/**
 * Builds a warm, band-limited combustion-pulse `PeriodicWave` for non-worklet environments.
 * Unlike raw sawtooth oscillators (which buzz harshly), this Fourier series emphasizes
 * low-to-mid firing harmonics with natural acoustic high-frequency rolloff.
 */
function tryCreateCombustionWave(ctx: AudioContext, sharpness: number): PeriodicWave | null {
  if (typeof ctx.createPeriodicWave !== 'function') return null;
  try {
    const harmonics = 20;
    const real = new Float32Array(harmonics + 1);
    const imag = new Float32Array(harmonics + 1);
    const rolloff = clampFinite(1.55 - sharpness * 0.35, 0.78, 1.45, 1.1);
    for (let n = 1; n <= harmonics; n++) {
      const mag = Math.pow(n, -rolloff) * Math.exp(-n * 0.085);
      // Slight phase skew creates asymmetric combustion pressure shape
      real[n] = mag * 0.35;
      imag[n] = mag * 0.94;
    }
    return ctx.createPeriodicWave(real, imag, { disableNormalization: false });
  } catch {
    return null;
  }
}

/**
 * Physical 4-stroke engine synthesizer with:
 * - Primary engine: 48 kHz inline-Blob `AudioWorkletNode` simulating sample-accurate 720°
 *   crankshaft combustion pulses, uneven dual-bank exhaust headers (e.g. cross-plane V8
 *   L-R-L-L-R-L-R-R grouping), physical tailpipe waveguides, Helmholtz muffler body,
 *   on-throttle intake plenum roar, off-throttle waveguide overrun crackles, turbo spool,
 *   and smooth tri-motor EV inverter harmonics.
 * - Upgraded fallback (when `AudioWorklet` is unavailable): band-limited `PeriodicWave`
 *   pulse-table stack + physical `DelayNode` exhaust pipe comb-resonator.
 * - Parallel outdoor exhaust-cabinet `ConvolverNode` ground-bounce reflections so the car
 *   sounds miked in real air, plus crisp multi-chirp JDM turbo blow-off valve flutter.
 */
export class EngineSynth {
  private readonly ctx: AudioContext;
  private readonly noise: AudioNoiseBank;
  private readonly output: GainNode;
  private readonly exhaustMixBus: GainNode;
  private readonly dryGain: GainNode;
  private readonly cabinetConvolver: ConvolverNode | null;
  private readonly cabinetWetGain: GainNode | null;

  // Primary 48 kHz physical AudioWorklet path (lazily attached in initWorklet)
  private workletNode: AudioWorkletNode | null = null;
  private readonly workletGain: GainNode;
  private workletReady = false;
  private workletInitPromise: Promise<boolean> | null = null;

  // Upgraded fallback path (PeriodicWave pulse-table + exhaust DelayNode waveguide)
  private readonly fallbackGain: GainNode;
  private readonly activeGain: GainNode;
  private readonly transientDuckGain: GainNode;
  private readonly lopeModGain: GainNode;
  private readonly preShaperBus: GainNode;
  private readonly loadDriveGain: GainNode;
  private readonly shaper: WaveShaperNode;
  private readonly exhaustLowpass: BiquadFilterNode;
  private readonly exhaustFormant: BiquadFilterNode;
  private readonly exhaustWarmth: BiquadFilterNode;
  private readonly postFilterBus: GainNode;

  // Fallback waveguide comb-delay (when ctx.createDelay is available)
  private readonly fbPipeDelay: DelayNode | null;
  private readonly fbPipeDamp: BiquadFilterNode | null;
  private readonly fbPipeFeedback: GainNode | null;

  private readonly subOsc: OscillatorNode;
  private readonly subGain: GainNode;
  private readonly harmonicOscs: OscillatorNode[] = [];
  private readonly harmonicGains: GainNode[] = [];

  private readonly idleLopeOsc: OscillatorNode;
  private readonly idleLopeDepthGain: GainNode;

  private readonly intakeNoise: AudioBufferSourceNode;
  private readonly intakeFilter: BiquadFilterNode;
  private readonly intakeGain: GainNode;
  private readonly shriekNoise: AudioBufferSourceNode;
  private readonly shriekFilter: BiquadFilterNode;
  private readonly shriekGain: GainNode;

  private readonly turboOsc: OscillatorNode;
  private readonly turboNoise: AudioBufferSourceNode;
  private readonly turboBandpass: BiquadFilterNode;
  private readonly turboOscGain: GainNode;
  private readonly turboNoiseGain: GainNode;
  private readonly turboGain: GainNode;

  private readonly evOsc1: OscillatorNode;
  private readonly evOsc2: OscillatorNode;
  private readonly evFilter: BiquadFilterNode;
  private readonly evGain: GainNode;

  private readonly curveCache = new Map<string, Float32Array<ArrayBuffer>>();
  private readonly waveCache = new Map<string, PeriodicWave>();
  private profile: EngineAcousticProfile = ENGINE_PROFILES.v10;
  private active = false;
  private disposed = false;

  // Telemetry & transient edge trackers
  private lastFramePayload: EngineWorkletFramePayload = {
    active: false,
    rpm: 900,
    idleRpm: 900,
    redlineRpm: 8600,
    throttle: 0,
    turboBoost: 0,
    speedMps: 0,
    engineHealth: 1,
    cameraBrightness: 1,
    cameraIntakeBoost: 1,
    cameraLevel: 1,
  };
  private prevRpm = 900;
  private prevThrottle = 0;
  private prevBoost = 0;
  private lastBoost = 0;
  private lastBovTime = -10;
  private crackleTimer = 0.12;
  private sputterTimer = 0.25;
  private limiterPhase = 0;
  private shiftDuckUntil = 0;
  private blipUntil = 0;
  private blipBoostRpm = 0;

  constructor(ctx: AudioContext, destination: AudioNode, noise: AudioNoiseBank, initialProfile?: EngineAcousticProfile) {
    this.ctx = ctx;
    this.noise = noise;
    const now = ctx.currentTime;

    this.output = ctx.createGain();
    this.output.gain.value = 1;
    this.output.connect(destination);

    // Parallel Dry + Outdoor Exhaust Cabinet / Asphalt Ground-Bounce Convolver
    this.exhaustMixBus = ctx.createGain();
    this.exhaustMixBus.gain.value = 1;

    this.dryGain = ctx.createGain();
    this.dryGain.gain.value = 0.84;
    this.exhaustMixBus.connect(this.dryGain);
    this.dryGain.connect(this.output);

    const outdoorIR = createExhaustOutdoorIR(ctx);
    this.cabinetConvolver = tryCreateConvolver(ctx, outdoorIR);
    if (this.cabinetConvolver) {
      this.cabinetWetGain = ctx.createGain();
      this.cabinetWetGain.gain.value = 0.34;
      this.exhaustMixBus.connect(this.cabinetConvolver);
      this.cabinetConvolver.connect(this.cabinetWetGain);
      this.cabinetWetGain.connect(this.output);
    } else {
      this.cabinetWetGain = null;
      this.dryGain.gain.value = 1.0;
    }

    // Worklet gain stage (starts at 0 until worklet finishes async loading)
    this.workletGain = ctx.createGain();
    this.workletGain.gain.value = 0;
    this.workletGain.connect(this.exhaustMixBus);

    // Fallback gain stage (starts at 1, smoothly crossfades to 0 once worklet attaches)
    this.fallbackGain = ctx.createGain();
    this.fallbackGain.gain.value = 1;
    this.fallbackGain.connect(this.exhaustMixBus);

    this.activeGain = ctx.createGain();
    this.activeGain.gain.value = 0;
    this.activeGain.connect(this.fallbackGain);

    this.transientDuckGain = ctx.createGain();
    this.transientDuckGain.gain.value = 1;
    this.transientDuckGain.connect(this.activeGain);

    this.postFilterBus = ctx.createGain();
    this.postFilterBus.gain.value = 1;
    this.postFilterBus.connect(this.transientDuckGain);

    // Optional physical exhaust-pipe comb waveguide on fallback path
    if (typeof ctx.createDelay === 'function') {
      const pipeDelay = ctx.createDelay(0.05);
      pipeDelay.delayTime.value = 0.0042;
      const pipeDamp = ctx.createBiquadFilter();
      pipeDamp.type = 'lowpass';
      pipeDamp.frequency.value = 1400;
      const pipeFb = ctx.createGain();
      pipeFb.gain.value = -0.36;

      this.postFilterBus.connect(pipeDelay);
      pipeDelay.connect(pipeDamp);
      pipeDamp.connect(pipeFb);
      pipeFb.connect(pipeDelay);
      pipeDamp.connect(this.transientDuckGain);

      this.fbPipeDelay = pipeDelay;
      this.fbPipeDamp = pipeDamp;
      this.fbPipeFeedback = pipeFb;
    } else {
      this.fbPipeDelay = null;
      this.fbPipeDamp = null;
      this.fbPipeFeedback = null;
    }

    this.exhaustWarmth = ctx.createBiquadFilter();
    this.exhaustWarmth.type = 'lowshelf';
    this.exhaustWarmth.frequency.value = 115;
    this.exhaustWarmth.gain.value = 4.2;
    this.exhaustWarmth.connect(this.postFilterBus);

    this.exhaustFormant = ctx.createBiquadFilter();
    this.exhaustFormant.type = 'peaking';
    this.exhaustFormant.frequency.value = 760;
    this.exhaustFormant.Q.value = 1.9;
    this.exhaustFormant.gain.value = 6.5;
    this.exhaustFormant.connect(this.exhaustWarmth);

    this.exhaustLowpass = ctx.createBiquadFilter();
    this.exhaustLowpass.type = 'lowpass';
    this.exhaustLowpass.frequency.value = 400;
    this.exhaustLowpass.Q.value = 0.85;
    this.exhaustLowpass.connect(this.exhaustFormant);

    this.shaper = ctx.createWaveShaper();
    this.shaper.oversample = '2x';
    this.shaper.connect(this.exhaustLowpass);

    this.loadDriveGain = ctx.createGain();
    this.loadDriveGain.gain.value = 0.5;
    this.loadDriveGain.connect(this.shaper);

    this.lopeModGain = ctx.createGain();
    this.lopeModGain.gain.value = 1;
    this.lopeModGain.connect(this.loadDriveGain);

    this.preShaperBus = ctx.createGain();
    this.preShaperBus.gain.value = 1;
    this.preShaperBus.connect(this.lopeModGain);

    // Sub-bass exhaust fundamental
    this.subGain = ctx.createGain();
    this.subGain.gain.value = 0.25;
    this.subGain.connect(this.preShaperBus);

    this.subOsc = ctx.createOscillator();
    this.subOsc.type = 'sine';
    this.subOsc.frequency.value = 45;
    this.subOsc.connect(this.subGain);
    this.subOsc.start(now);

    // 4-layer band-limited combustion harmonic stack (fallback)
    for (let i = 0; i < 4; i++) {
      const gain = ctx.createGain();
      gain.gain.value = 0.15;
      gain.connect(this.preShaperBus);

      const osc = ctx.createOscillator();
      osc.type = i === 0 ? 'sawtooth' : 'triangle';
      osc.frequency.value = 80 * (i + 1);
      osc.connect(gain);
      osc.start(now);

      this.harmonicGains.push(gain);
      this.harmonicOscs.push(osc);
    }

    // Cam-lope idle modulator
    this.idleLopeDepthGain = ctx.createGain();
    this.idleLopeDepthGain.gain.value = 0.05;
    this.idleLopeDepthGain.connect(this.lopeModGain.gain);

    this.idleLopeOsc = ctx.createOscillator();
    this.idleLopeOsc.type = 'sine';
    this.idleLopeOsc.frequency.value = 8.5;
    this.idleLopeOsc.connect(this.idleLopeDepthGain);
    this.idleLopeOsc.start(now);

    // Pre-shaper combustion / intake air texture
    this.intakeFilter = ctx.createBiquadFilter();
    this.intakeFilter.type = 'bandpass';
    this.intakeFilter.frequency.value = 340;
    this.intakeFilter.Q.value = 1.4;

    this.intakeGain = ctx.createGain();
    this.intakeGain.gain.value = 0.08;
    this.intakeFilter.connect(this.intakeGain);
    this.intakeGain.connect(this.preShaperBus);
    this.intakeNoise = createLoopingNoise(ctx, noise.pink, this.intakeFilter);

    // High-RPM induction shriek layer
    this.shriekFilter = ctx.createBiquadFilter();
    this.shriekFilter.type = 'bandpass';
    this.shriekFilter.frequency.value = 1800;
    this.shriekFilter.Q.value = 1.6;

    this.shriekGain = ctx.createGain();
    this.shriekGain.gain.value = 0;
    this.shriekFilter.connect(this.shriekGain);
    this.shriekGain.connect(this.postFilterBus);
    this.shriekNoise = createLoopingNoise(ctx, noise.white, this.shriekFilter);

    // Turbocharger spool whine (fallback)
    this.turboGain = ctx.createGain();
    this.turboGain.gain.value = 0;
    this.turboGain.connect(this.postFilterBus);

    this.turboOscGain = ctx.createGain();
    this.turboOscGain.gain.value = 0.55;
    this.turboOscGain.connect(this.turboGain);

    this.turboOsc = ctx.createOscillator();
    this.turboOsc.type = 'sine';
    this.turboOsc.frequency.value = 1800;
    this.turboOsc.connect(this.turboOscGain);
    this.turboOsc.start(now);

    this.turboBandpass = ctx.createBiquadFilter();
    this.turboBandpass.type = 'bandpass';
    this.turboBandpass.frequency.value = 2600;
    this.turboBandpass.Q.value = 4.2;

    this.turboNoiseGain = ctx.createGain();
    this.turboNoiseGain.gain.value = 0.45;
    this.turboBandpass.connect(this.turboNoiseGain);
    this.turboNoiseGain.connect(this.turboGain);
    this.turboNoise = createLoopingNoise(ctx, noise.white, this.turboBandpass);

    // Electric hypercar inverter layer (fallback)
    this.evGain = ctx.createGain();
    this.evGain.gain.value = 0;
    this.evGain.connect(this.postFilterBus);

    this.evFilter = ctx.createBiquadFilter();
    this.evFilter.type = 'bandpass';
    this.evFilter.frequency.value = 900;
    this.evFilter.Q.value = 1.2;
    this.evFilter.connect(this.evGain);

    this.evOsc1 = ctx.createOscillator();
    this.evOsc1.type = 'sine';
    this.evOsc1.frequency.value = 220;
    this.evOsc1.connect(this.evFilter);
    this.evOsc1.start(now);

    this.evOsc2 = ctx.createOscillator();
    this.evOsc2.type = 'triangle';
    this.evOsc2.frequency.value = 330;
    this.evOsc2.connect(this.evFilter);
    this.evOsc2.start(now);

    this.setProfile(initialProfile ?? ENGINE_PROFILES.v10);
  }

  /**
   * Loads the 48 kHz physical 4-stroke crankshaft combustion `AudioWorklet` from an inline Blob URL
   * and seamlessly crossfades from the fallback synth to the worklet. Safe no-op if unavailable.
   */
  async initWorklet(): Promise<boolean> {
    if (this.disposed) return false;
    if (this.workletReady) return true;
    if (this.workletInitPromise) return this.workletInitPromise;

    this.workletInitPromise = (async () => {
      const node = await tryCreateEngineWorkletNode(this.ctx);
      if (!node || this.disposed) {
        if (node) {
          try {
            node.port.postMessage({ type: 'dispose' });
            node.disconnect();
          } catch {
            // Ignore cleanup errors.
          }
        }
        return false;
      }

      this.workletNode = node;
      node.connect(this.workletGain);
      node.port.postMessage({ type: 'profile', profile: serializeWorkletProfile(this.profile) });
      node.port.postMessage({ type: 'frame', frame: this.lastFramePayload });

      const now = this.ctx.currentTime;
      this.workletReady = true;
      // Zero-click crossfade from fallback to physical 48 kHz worklet
      safeSetTarget(this.fallbackGain.gain, 0, now, 0.03, 0, 1);
      safeSetTarget(this.workletGain.gain, 1, now, 0.03, 0, 1);
      return true;
    })().finally(() => {
      this.workletInitPromise = null;
    });

    return this.workletInitPromise;
  }

  /** Returns `true` when the 48 kHz physical `AudioWorklet` engine is actively running. */
  isUsingWorklet(): boolean {
    return this.workletReady && !this.disposed;
  }

  /** Switches the active acoustic profile without clicking or tearing down nodes. */
  setProfile(profile: EngineAcousticProfile): void {
    if (this.disposed) return;
    this.profile = profile;
    const now = this.ctx.currentTime;

    if (this.workletNode && this.workletReady) {
      try {
        this.workletNode.port.postMessage({ type: 'profile', profile: serializeWorkletProfile(profile) });
      } catch {
        // Ignore closed port.
      }
    }

    // Configure fallback harmonic pulse-tables & waveguide comb delay
    const waveKey = profile.physical.pulseSharpness.toFixed(2);
    let pulseWave = this.waveCache.get(waveKey);
    if (!pulseWave) {
      const created = tryCreateCombustionWave(this.ctx, profile.physical.pulseSharpness);
      if (created) {
        this.waveCache.set(waveKey, created);
        pulseWave = created;
      }
    }

    for (let i = 0; i < 4; i++) {
      const layer = profile.harmonics[i];
      const osc = this.harmonicOscs[i];
      if (pulseWave && layer.waveform === 'sawtooth' && typeof osc.setPeriodicWave === 'function') {
        try {
          osc.setPeriodicWave(pulseWave);
        } catch {
          osc.type = layer.waveform;
        }
      } else {
        osc.type = layer.waveform;
      }
      safeSetTarget(osc.detune, layer.detuneCents ?? 0, now, 0.03, -100, 100);
    }

    const curveKey = `${profile.saturationDrive.toFixed(2)}:${profile.saturationBias.toFixed(2)}`;
    let curve = this.curveCache.get(curveKey);
    if (!curve) {
      curve = createCombustionCurve(profile.saturationDrive, profile.saturationBias);
      this.curveCache.set(curveKey, curve);
    }
    this.shaper.curve = curve;

    if (this.fbPipeDelay && this.fbPipeDamp && this.fbPipeFeedback) {
      safeSetTarget(this.fbPipeDelay.delayTime, profile.physical.tailpipeDelayMs * 0.001, now, 0.04, 0.0015, 0.02);
      safeSetTarget(this.fbPipeDamp.frequency, lerpClamped(2400, 720, profile.physical.pipeDamping), now, 0.04, 300, 4500);
      safeSetTarget(this.fbPipeFeedback.gain, -clampFinite(profile.physical.pipeFeedback * 0.72, 0.1, 0.52, 0.34), now, 0.04, -0.6, 0);
    }

    safeSetTarget(this.idleLopeOsc.frequency, profile.idleLopeHz, now, 0.05, 1, 30);
    safeSetTarget(this.exhaustFormant.Q, profile.formantQ, now, 0.04, 0.4, 8);
    safeSetTarget(this.exhaustFormant.gain, profile.formantGainDb, now, 0.04, -6, 14);
    safeSetTarget(this.output.gain, profile.outputTrim, now, 0.04, 0.1, 1.5);
  }

  getProfile(): EngineAcousticProfile {
    return this.profile;
  }

  /** Smoothly fades the continuous driving engine in or out (zero click). */
  setActive(active: boolean): void {
    if (this.disposed) return;
    this.active = active;
    this.lastFramePayload = { ...this.lastFramePayload, active };
    const now = this.ctx.currentTime;

    if (this.workletNode && this.workletReady) {
      try {
        this.workletNode.port.postMessage({ type: 'frame', frame: this.lastFramePayload });
      } catch {
        // Ignore closed port.
      }
    }

    safeSetTarget(this.activeGain.gain, active ? 0.54 : 0, now, active ? 0.045 : 0.06, 0, 1);
    if (!active) {
      safeSetTarget(this.turboGain.gain, 0, now, 0.05, 0, 1);
      safeSetTarget(this.evGain.gain, 0, now, 0.05, 0, 1);
      safeSetTarget(this.shriekGain.gain, 0, now, 0.05, 0, 1);
    }
  }

  /** Per-frame continuous synthesis update driven by live physics telemetry. */
  update(frame: DriveAudioFrame): void {
    if (this.disposed || !this.active) return;

    const now = this.ctx.currentTime;
    const p = this.profile;
    const dt = clampFinite(frame.dt, 0.001, 0.1, 1 / 60);
    const idleRpm = clampFinite(frame.idleRpm, 400, 2000, p.idleRpm);
    const redlineRpm = clampFinite(frame.redlineRpm, idleRpm + 1500, 15000, p.redlineRpm);
    const rawRpm = clampFinite(frame.rpm, 0, redlineRpm * 1.12, idleRpm);
    const throttle = clampFinite(frame.throttle, 0, 1, 0);
    const boost = clampFinite(frame.turboBoost, 0, 1, 0);
    const speedMps = clampFinite(Math.abs(frame.speedMps), 0, 140, 0);
    const health = clampFinite(frame.engineHealth, 0, 1, 1);
    const evBlend = clampFinite(p.electricWhine ?? 0, 0, 1, 0);

    // Camera-aware acoustic presence
    let cameraBrightness = 1.0;
    let cameraIntakeBoost = 1.0;
    let cameraLevel = 1.0;
    switch (frame.cameraMode) {
      case 'hood':
      case 'bumper':
        cameraBrightness = 1.18;
        cameraIntakeBoost = 1.42;
        cameraLevel = 1.06;
        break;
      case 'chase-far':
        cameraBrightness = 0.85;
        cameraIntakeBoost = 0.78;
        cameraLevel = 0.90;
        break;
      case 'orbit':
        cameraBrightness = 0.93;
        cameraIntakeBoost = 0.86;
        cameraLevel = 0.95;
        break;
      default:
        break;
    }

    const rpmNorm = clampFinite((Math.max(idleRpm * 0.72, rawRpm) - idleRpm) / Math.max(1, redlineRpm - idleRpm), 0, 1.08, 0);
    const effectiveBoost = p.hasTurbo ? Math.max(boost, Math.max(0, (rpmNorm - 0.24) * throttle * 0.95)) : 0;

    // Blow-off valve flutter triggers cleanly on BOTH worklet and fallback paths!
    if (p.hasTurbo && p.bovIntensity > 0.05) {
      const throttleDropped = this.prevThrottle - throttle > 0.22 && throttle < 0.24;
      if (throttleDropped && this.prevBoost > 0.26 && now - this.lastBovTime > 0.28) {
        this.playBlowOffValve(clampFinite(this.prevBoost * p.bovIntensity, 0.25, 1, 0.6));
      }
    }

    this.lastFramePayload = {
      active: true,
      rpm: rawRpm,
      idleRpm,
      redlineRpm,
      throttle,
      turboBoost: effectiveBoost,
      speedMps,
      engineHealth: health,
      cameraBrightness,
      cameraIntakeBoost,
      cameraLevel,
    };

    if (this.workletNode && this.workletReady) {
      try {
        this.workletNode.port.postMessage({ type: 'frame', frame: this.lastFramePayload });
      } catch {
        // Ignore closed port.
      }
      this.prevRpm = rawRpm;
      this.prevThrottle = throttle;
      this.prevBoost = effectiveBoost;
      this.lastBoost = effectiveBoost;
      return;
    }

    // --- Fallback synthesis update (when AudioWorklet is unavailable) ---
    let effectiveRpm = Math.max(idleRpm * 0.72, rawRpm);
    let effectiveThrottle = throttle;
    if (now < this.blipUntil) {
      const k = clampFinite((this.blipUntil - now) / 0.14, 0, 1, 0);
      effectiveRpm += this.blipBoostRpm * k;
      effectiveThrottle = Math.max(effectiveThrottle, 0.78 * k);
    }

    const fbRpmNorm = clampFinite((effectiveRpm - idleRpm) / Math.max(1, redlineRpm - idleRpm), 0, 1.08, 0);
    const load = clampFinite(effectiveThrottle * 0.78 + fbRpmNorm * 0.22, 0, 1, 0);
    const damageFactor = health < 0.65 ? clampFinite((0.65 - health) / 0.65, 0, 1, 0) : 0;
    const damageJitter = damageFactor > 0 ? Math.sin(now * 29.3) * Math.cos(now * 13.7) * damageFactor * 0.065 : 0;
    const firingHz = clampFinite((effectiveRpm / 60) * p.firingOrder * p.pitchScale * (1 + damageJitter), 16, 1600, 60);
    const combustionScale = 1 - evBlend * 0.82;

    safeSetTarget(this.subOsc.frequency, firingHz * 0.5, now, 0.018, 18, 900);
    safeSetTarget(
      this.subGain.gain,
      p.subGain * (0.85 + effectiveThrottle * 0.45 - fbRpmNorm * 0.15) * combustionScale,
      now,
      0.03,
      0,
      1,
    );

    for (let i = 0; i < 4; i++) {
      const layer = p.harmonics[i];
      const freq = clampFinite(firingHz * layer.ratio, 22, 9500, 100);
      const gain = (layer.baseGain + layer.loadGain * (effectiveThrottle * 0.65 + fbRpmNorm * 0.55)) * combustionScale;
      safeSetTarget(this.harmonicOscs[i].frequency, freq, now, 0.018, 20, 9800);
      safeSetTarget(this.harmonicGains[i].gain, gain, now, 0.028, 0, 1.2);
    }

    const idleProximity = clampFinite(1 - fbRpmNorm * 3.4, 0, 1, 0);
    const lopeDepth = (p.idleLopeDepth * idleProximity + damageFactor * 0.18) * (1 - effectiveThrottle * 0.75);
    safeSetTarget(this.idleLopeDepthGain.gain, lopeDepth * combustionScale, now, 0.04, 0, 0.45);
    safeSetTarget(this.idleLopeOsc.frequency, p.idleLopeHz + damageFactor * 3.5, now, 0.05, 2, 24);

    const driveGain = lerpClamped(0.36, 1.25, effectiveThrottle * 0.72 + fbRpmNorm * 0.28) * (1 - evBlend * 0.5);
    safeSetTarget(this.loadDriveGain.gain, driveGain, now, 0.028, 0.12, 1.8);

    const cutoff =
      lerpClamped(p.filterMinHz, p.filterMaxHz, Math.pow(fbRpmNorm, 0.88) * 0.68 + effectiveThrottle * 0.36) *
      cameraBrightness;
    const formantHz = lerpClamped(p.formantMinHz, p.formantMaxHz, Math.pow(fbRpmNorm, 0.92));
    safeSetTarget(this.exhaustLowpass.frequency, cutoff, now, 0.025, 160, 11000);
    safeSetTarget(this.exhaustFormant.frequency, formantHz, now, 0.028, 120, 4800);

    const intakeFreq = clampFinite(firingHz * 3.4, 180, 4400, 450);
    safeSetTarget(this.intakeFilter.frequency, intakeFreq, now, 0.03, 150, 5000);
    safeSetTarget(
      this.intakeGain.gain,
      (0.05 + load * 0.14 + damageFactor * 0.05) * combustionScale * cameraIntakeBoost,
      now,
      0.03,
      0,
      0.4,
    );

    const shriekDrive = Math.max(0, fbRpmNorm - 0.35) / 0.65;
    const shriekLevel = p.inductionGain * Math.pow(shriekDrive, 1.45) * (0.35 + effectiveThrottle * 0.65) * 0.22 * cameraIntakeBoost;
    safeSetTarget(this.shriekFilter.frequency, lerpClamped(1350, 3900, fbRpmNorm), now, 0.03, 700, 6000);
    safeSetTarget(this.shriekGain.gain, shriekLevel, now, 0.03, 0, 0.45);

    if (p.hasTurbo && p.turboWhineGain > 0) {
      const turboFreq = lerpClamped(p.turboPitchRange[0], p.turboPitchRange[1], Math.pow(effectiveBoost, 0.85));
      const turboLevel = p.turboWhineGain * Math.pow(effectiveBoost, 1.25) * 0.14 * cameraIntakeBoost;
      safeSetTarget(this.turboOsc.frequency, turboFreq, now, 0.03, 900, 9500);
      safeSetTarget(this.turboBandpass.frequency, turboFreq * 1.18, now, 0.03, 1000, 10000);
      safeSetTarget(this.turboGain.gain, turboLevel, now, 0.035, 0, 0.35);
    } else {
      safeSetTarget(this.turboGain.gain, 0, now, 0.04, 0, 0.2);
    }

    if (evBlend > 0.02) {
      const speedNorm = clampFinite(speedMps / 85, 0, 1.2, 0);
      const evPitch = lerpClamped(185, 2150, Math.max(fbRpmNorm * 0.65, speedNorm * 0.95));
      const evLevel = evBlend * (0.045 + Math.pow(effectiveThrottle, 0.85) * 0.22 + speedNorm * 0.16) * cameraIntakeBoost;
      safeSetTarget(this.evOsc1.frequency, evPitch, now, 0.02, 120, 4800);
      safeSetTarget(this.evOsc2.frequency, evPitch * 1.502, now, 0.02, 180, 7200);
      safeSetTarget(this.evFilter.frequency, clampFinite(evPitch * 1.35, 300, 6200, 900), now, 0.03, 250, 7200);
      safeSetTarget(this.evGain.gain, evLevel, now, 0.03, 0, 0.45);
    } else {
      safeSetTarget(this.evGain.gain, 0, now, 0.04, 0, 0.2);
    }

    let duckTarget = cameraLevel * lerpClamped(0.68, 1.06, effectiveThrottle * 0.55 + fbRpmNorm * 0.45);
    if (now < this.shiftDuckUntil) {
      duckTarget *= 0.24;
    } else if (fbRpmNorm >= 0.985 && effectiveThrottle > 0.45 && evBlend < 0.5) {
      this.limiterPhase += dt * 19.5;
      if (Math.sin(this.limiterPhase * Math.PI * 2) > 0.2) {
        duckTarget *= 0.28;
      }
    }

    if (damageFactor > 0.08 && evBlend < 0.5) {
      this.sputterTimer -= dt;
      if (this.sputterTimer <= 0) {
        this.sputterTimer = lerpClamped(0.42, 0.075, damageFactor) * (0.65 + Math.random() * 0.7);
        if (Math.random() < damageFactor * 0.72) {
          this.triggerMisfireSputter(damageFactor);
        }
      }
    }

    safeSetTarget(this.transientDuckGain.gain, duckTarget, now, 0.014, 0.05, 1.4);

    if (p.crackleIntensity > 0.05 && evBlend < 0.5 && throttle < 0.1 && fbRpmNorm > 0.26) {
      const decelerating = rawRpm <= this.prevRpm + 25;
      if (decelerating) {
        this.crackleTimer -= dt;
        if (this.crackleTimer <= 0) {
          const popStrength = clampFinite(p.crackleIntensity * (0.35 + fbRpmNorm * 0.65), 0.15, 1, 0.4);
          this.playExhaustPop(popStrength, fbRpmNorm > 0.55);
          this.crackleTimer = lerpClamped(0.24, 0.065, fbRpmNorm) * (0.65 + Math.random() * 0.85);
        }
      }
    } else {
      this.crackleTimer = Math.min(this.crackleTimer, 0.09);
    }

    this.prevRpm = rawRpm;
    this.prevThrottle = throttle;
    this.prevBoost = effectiveBoost;
    this.lastBoost = effectiveBoost;
  }

  /** Plays realistic starter motor cranking followed by a cold-start rev bark. */
  playIgnition(): void {
    if (this.disposed) return;
    const now = this.ctx.currentTime;
    const p = this.profile;

    if ((p.electricWhine ?? 0) > 0.5) {
      this.playElectricPowerOn(now);
      return;
    }

    if (this.workletNode && this.workletReady) {
      try {
        this.workletNode.port.postMessage({ type: 'ignition' });
      } catch {
        // Ignore closed port.
      }
      return;
    }

    // Fallback starter cranking pulses + cold-start bark
    const crankCount = 3;
    const crankInterval = 0.115;
    for (let i = 0; i < crankCount; i++) {
      const t = now + i * crankInterval;
      const osc = this.ctx.createOscillator();
      const filter = this.ctx.createBiquadFilter();
      const gain = this.ctx.createGain();

      osc.type = 'sawtooth';
      safeSetValue(osc.frequency, p.starterCrankHz * (0.94 + i * 0.04), t, 40, 400);
      safeLinearRamp(osc.frequency, p.starterCrankHz * 1.24, t + 0.075, 40, 500);

      filter.type = 'bandpass';
      filter.frequency.value = p.starterCrankHz * 3.1;
      filter.Q.value = 2.4;

      safeSetValue(gain.gain, 0.0001, t, 0.0001, 1);
      safeLinearRamp(gain.gain, 0.16, t + 0.018, 0, 1);
      safeExpRamp(gain.gain, 0.001, t + 0.098, 0.0001, 1);

      osc.connect(filter);
      filter.connect(gain);
      gain.connect(this.exhaustMixBus);

      osc.start(t);
      scheduleStop(osc, t + 0.105, [filter, gain]);
    }

    const catchTime = now + crankCount * crankInterval - 0.02;
    this.playCombustionFlare(catchTime, p, 0.52, 0.62, 0.36);
  }

  /** Plays a gear-shift acoustic transient: ignition-cut bark on upshift, rev-match blip on downshift. */
  playShift(direction: ShiftDirection, rpm = this.prevRpm): void {
    if (this.disposed) return;
    const now = this.ctx.currentTime;
    const p = this.profile;
    const safeRpm = clampFinite(rpm, p.idleRpm, p.redlineRpm * 1.1, p.idleRpm * 2);
    const rpmNorm = clampFinite((safeRpm - p.idleRpm) / Math.max(1, p.redlineRpm - p.idleRpm), 0, 1, 0.4);

    if ((p.electricWhine ?? 0) > 0.5) {
      const osc = this.ctx.createOscillator();
      const g = this.ctx.createGain();
      osc.type = 'sine';
      safeSetValue(osc.frequency, direction === 'up' ? 540 : 420, now, 100, 2000);
      safeExpRamp(osc.frequency, direction === 'up' ? 880 : 300, now + 0.05, 100, 2000);
      safeSetValue(g.gain, 0.04, now, 0.0001, 0.5);
      safeExpRamp(g.gain, 0.0005, now + 0.055, 0.0001, 0.5);
      osc.connect(g);
      g.connect(this.exhaustMixBus);
      osc.start(now);
      scheduleStop(osc, now + 0.06, [g]);
      return;
    }

    if (this.workletNode && this.workletReady) {
      try {
        this.workletNode.port.postMessage({ type: 'shift', direction, rpm: safeRpm });
      } catch {
        // Ignore closed port.
      }
      if (direction === 'down') {
        this.playMechanicalShiftClunk(now, 0.11);
      } else if (p.hasTurbo && this.lastBoost > 0.18 && now - this.lastBovTime > 0.22) {
        this.playBlowOffValve(clampFinite(this.lastBoost * p.bovIntensity * 0.9, 0.22, 1, 0.5));
      }
      return;
    }

    if (direction === 'up') {
      this.shiftDuckUntil = now + 0.068;
      const popStrength = clampFinite(p.shiftPopIntensity * (0.45 + rpmNorm * 0.55), 0.2, 1, 0.5);
      this.playExhaustPop(popStrength, true, 0.024);

      if (p.hasTurbo && this.lastBoost > 0.18 && now - this.lastBovTime > 0.22) {
        this.playBlowOffValve(clampFinite(this.lastBoost * p.bovIntensity * 0.9, 0.22, 1, 0.5));
      }
    } else {
      this.blipUntil = now + 0.145;
      this.blipBoostRpm = clampFinite(950 + rpmNorm * 1400, 650, 2600, 1200);
      this.playMechanicalShiftClunk(now, 0.12);
      if (p.crackleIntensity > 0.2 && rpmNorm > 0.25) {
        this.playExhaustPop(p.crackleIntensity * 0.55, false, 0.075);
      }
    }
  }

  /**
   * Plays a brief, self-contained ignition + throttle-blip rev preview for showroom car selection.
   * Uses the 48 kHz physical exhaust waveguide when active, or fallback flare otherwise.
   */
  playRevPreview(profileOverride?: EngineAcousticProfile): void {
    if (this.disposed) return;
    const p = profileOverride ?? this.profile;
    const now = this.ctx.currentTime;

    if ((p.electricWhine ?? 0) > 0.5) {
      this.playElectricPowerOn(now);
      return;
    }

    if (this.workletNode && this.workletReady) {
      try {
        this.workletNode.port.postMessage({ type: 'revPreview', profile: serializeWorkletProfile(p) });
      } catch {
        // Ignore closed port.
      }
      if (p.hasTurbo && p.bovIntensity > 0.2) {
        this.playBlowOffValve(0.76 * p.bovIntensity, 0.36);
      }
      return;
    }

    this.playCombustionFlare(now + 0.04, p, 0.62, 0.85, 0.30);

    if (p.hasTurbo && p.bovIntensity > 0.2) {
      this.playBlowOffValve(0.75 * p.bovIntensity, 0.52);
    } else if (p.crackleIntensity > 0.35) {
      this.playExhaustPop(p.crackleIntensity * 0.55, true, 0.62);
      this.playExhaustPop(p.crackleIntensity * 0.38, false, 0.74);
    }
  }

  /** Stops all continuous nodes, tears down the worklet, and disconnects cleanly. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.active = false;
    this.workletReady = false;
    const now = this.ctx.currentTime;

    if (this.workletNode) {
      try {
        this.workletNode.port.postMessage({ type: 'dispose' });
        this.workletNode.disconnect();
      } catch {
        // Ignore already-closed port.
      }
      this.workletNode = null;
    }

    const sources: AudioScheduledSourceNode[] = [
      this.subOsc,
      ...this.harmonicOscs,
      this.idleLopeOsc,
      this.intakeNoise,
      this.shriekNoise,
      this.turboOsc,
      this.turboNoise,
      this.evOsc1,
      this.evOsc2,
    ];
    for (const src of sources) {
      try {
        src.stop(now + 0.01);
        src.disconnect();
      } catch {
        // Ignore already-stopped nodes.
      }
    }

    for (const node of [
      this.fbPipeDelay,
      this.fbPipeDamp,
      this.fbPipeFeedback,
      this.cabinetConvolver,
      this.cabinetWetGain,
      this.dryGain,
      this.workletGain,
      this.fallbackGain,
      this.exhaustMixBus,
      this.output,
    ]) {
      try {
        node?.disconnect();
      } catch {
        // Ignore already-disconnected nodes.
      }
    }
  }

  // ------------------------------------------------------------------ one-shot transient builders

  private playBlowOffValve(intensity: number, delaySec = 0): void {
    const start = this.ctx.currentTime + Math.max(0, delaySec);
    this.lastBovTime = start;
    const strength = clampFinite(intensity, 0.1, 1, 0.5);

    const hiss = this.ctx.createBufferSource();
    hiss.buffer = this.noise.white;
    hiss.loop = true;

    const hp = this.ctx.createBiquadFilter();
    hp.type = 'bandpass';
    safeSetValue(hp.frequency, 4400, start, 500, 10000);
    safeExpRamp(hp.frequency, 2200, start + 0.24, 500, 10000);
    hp.Q.value = 1.6;

    const hissGain = this.ctx.createGain();
    safeSetValue(hissGain.gain, 0.0001, start, 0.0001, 1);
    safeLinearRamp(hissGain.gain, 0.14 * strength, start + 0.014, 0, 1);
    safeExpRamp(hissGain.gain, 0.0005, start + 0.25, 0.0001, 1);

    hiss.connect(hp);
    hp.connect(hissGain);
    hissGain.connect(this.exhaustMixBus);
    hiss.start(start);
    scheduleStop(hiss, start + 0.27, [hp, hissGain]);

    const chirps = 5;
    for (let i = 0; i < chirps; i++) {
      const t = start + 0.012 + i * (0.048 + i * 0.005);
      const decay = Math.pow(0.72, i) * strength;
      const src = this.ctx.createBufferSource();
      src.buffer = this.noise.white;

      const bp = this.ctx.createBiquadFilter();
      bp.type = 'bandpass';
      const baseFreq = 3500 - i * 310;
      safeSetValue(bp.frequency, baseFreq, t, 400, 9000);
      safeExpRamp(bp.frequency, baseFreq * 0.68, t + 0.045, 400, 9000);
      bp.Q.value = 4.6;

      const g = this.ctx.createGain();
      safeSetValue(g.gain, 0.0001, t, 0.0001, 1);
      safeLinearRamp(g.gain, 0.17 * decay, t + 0.008, 0, 1);
      safeExpRamp(g.gain, 0.0005, t + 0.048, 0.0001, 1);

      src.connect(bp);
      bp.connect(g);
      g.connect(this.exhaustMixBus);
      src.start(t);
      scheduleStop(src, t + 0.055, [bp, g]);
    }
  }

  private playExhaustPop(intensity: number, sharp: boolean, delaySec = 0): void {
    const start = this.ctx.currentTime + Math.max(0, delaySec);
    const strength = clampFinite(intensity, 0.08, 1, 0.4);

    const thumpOsc = this.ctx.createOscillator();
    const thumpGain = this.ctx.createGain();
    thumpOsc.type = 'triangle';
    const startHz = sharp ? 155 + Math.random() * 40 : 108 + Math.random() * 25;
    safeSetValue(thumpOsc.frequency, startHz, start, 30, 500);
    safeExpRamp(thumpOsc.frequency, 44, start + 0.085, 25, 400);

    safeSetValue(thumpGain.gain, 0.0001, start, 0.0001, 1);
    safeLinearRamp(thumpGain.gain, 0.24 * strength, start + 0.005, 0, 1);
    safeExpRamp(thumpGain.gain, 0.0008, start + 0.095, 0.0001, 1);

    thumpOsc.connect(thumpGain);
    thumpGain.connect(this.exhaustMixBus);
    thumpOsc.start(start);
    scheduleStop(thumpOsc, start + 0.105, [thumpGain]);

    const snap = this.ctx.createBufferSource();
    snap.buffer = this.noise.white;

    const bp = this.ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = sharp ? 1250 + Math.random() * 750 : 620 + Math.random() * 320;
    bp.Q.value = sharp ? 1.5 : 2.1;

    const snapGain = this.ctx.createGain();
    safeSetValue(snapGain.gain, 0.0001, start, 0.0001, 1);
    safeLinearRamp(snapGain.gain, (sharp ? 0.26 : 0.16) * strength, start + 0.004, 0, 1);
    safeExpRamp(snapGain.gain, 0.0006, start + (sharp ? 0.068 : 0.095), 0.0001, 1);

    snap.connect(bp);
    bp.connect(snapGain);
    snapGain.connect(this.exhaustMixBus);
    snap.start(start);
    scheduleStop(snap, start + 0.11, [bp, snapGain]);
  }

  private playMechanicalShiftClunk(start: number, volume: number): void {
    const osc = this.ctx.createOscillator();
    const g = this.ctx.createGain();
    osc.type = 'triangle';
    safeSetValue(osc.frequency, 185, start, 40, 600);
    safeExpRamp(osc.frequency, 64, start + 0.045, 30, 600);

    safeSetValue(g.gain, 0.0001, start, 0.0001, 1);
    safeLinearRamp(g.gain, volume, start + 0.004, 0, 1);
    safeExpRamp(g.gain, 0.0005, start + 0.055, 0.0001, 1);

    osc.connect(g);
    g.connect(this.exhaustMixBus);
    osc.start(start);
    scheduleStop(osc, start + 0.062, [g]);
  }

  private triggerMisfireSputter(damageFactor: number): void {
    const now = this.ctx.currentTime;
    safeSetTarget(this.transientDuckGain.gain, lerpClamped(0.62, 0.22, damageFactor), now, 0.008, 0.05, 1.2);

    const osc = this.ctx.createOscillator();
    const g = this.ctx.createGain();
    osc.type = 'square';
    safeSetValue(osc.frequency, 620 + Math.random() * 280, now, 100, 2000);
    safeExpRamp(osc.frequency, 210, now + 0.03, 60, 2000);
    safeSetValue(g.gain, 0.0001, now, 0.0001, 1);
    safeLinearRamp(g.gain, 0.045 * damageFactor, now + 0.003, 0, 0.4);
    safeExpRamp(g.gain, 0.0004, now + 0.036, 0.0001, 0.4);

    osc.connect(g);
    g.connect(this.exhaustMixBus);
    osc.start(now);
    scheduleStop(osc, now + 0.042, [g]);
  }

  private playCombustionFlare(
    start: number,
    p: EngineAcousticProfile,
    peakRpmRatio: number,
    durationSec: number,
    level: number,
  ): void {
    const peakRpm = lerpClamped(p.idleRpm, p.redlineRpm, peakRpmRatio);
    const idleHz = clampFinite((p.idleRpm / 60) * p.firingOrder * p.pitchScale, 25, 600, 60);
    const peakHz = clampFinite((peakRpm / 60) * p.firingOrder * p.pitchScale, 60, 1400, 220);

    const bus = this.ctx.createGain();
    const shaper = this.ctx.createWaveShaper();
    shaper.curve = createCombustionCurve(p.saturationDrive, p.saturationBias, 512);

    const lp = this.ctx.createBiquadFilter();
    lp.type = 'lowpass';
    safeSetValue(lp.frequency, p.filterMinHz * 1.2, start, 150, 9000);
    safeExpRamp(lp.frequency, p.filterMaxHz * 0.72, start + durationSec * 0.34, 150, 9000);
    safeExpRamp(lp.frequency, p.filterMinHz * 0.9, start + durationSec, 150, 9000);

    const formant = this.ctx.createBiquadFilter();
    formant.type = 'peaking';
    formant.Q.value = p.formantQ;
    formant.gain.value = p.formantGainDb;
    safeSetValue(formant.frequency, p.formantMinHz, start, 120, 4500);
    safeExpRamp(formant.frequency, lerpClamped(p.formantMinHz, p.formantMaxHz, peakRpmRatio), start + durationSec * 0.34, 120, 4500);

    const env = this.ctx.createGain();
    safeSetValue(env.gain, 0.0001, start, 0.0001, 1);
    safeLinearRamp(env.gain, level, start + 0.06, 0, 1);
    safeLinearRamp(env.gain, level * 0.72, start + durationSec * 0.45, 0, 1);
    safeExpRamp(env.gain, 0.0005, start + durationSec, 0.0001, 1);

    bus.connect(shaper);
    shaper.connect(lp);
    lp.connect(formant);
    formant.connect(env);
    env.connect(this.exhaustMixBus);

    const cleanupNodes: AudioNode[] = [bus, shaper, lp, formant, env];
    const ratios = [0.5, p.harmonics[0].ratio, p.harmonics[1].ratio, p.harmonics[2].ratio];
    const weights = [p.subGain * 0.85, 0.42, 0.28, 0.20];
    const shapes: OscillatorType[] = ['sine', p.harmonics[0].waveform, p.harmonics[1].waveform, p.harmonics[2].waveform];

    for (let i = 0; i < ratios.length; i++) {
      const osc = this.ctx.createOscillator();
      const g = this.ctx.createGain();
      osc.type = shapes[i];
      g.gain.value = weights[i];

      safeSetValue(osc.frequency, idleHz * ratios[i] * 0.9, start, 20, 8000);
      safeExpRamp(osc.frequency, peakHz * ratios[i], start + durationSec * 0.32, 20, 8000);
      safeExpRamp(osc.frequency, idleHz * ratios[i] * 1.05, start + durationSec, 20, 8000);

      osc.connect(g);
      g.connect(bus);
      osc.start(start);
      scheduleStop(osc, start + durationSec + 0.04, i === 0 ? [...cleanupNodes, g] : [g]);
    }
  }

  private playElectricPowerOn(start: number): void {
    const osc1 = this.ctx.createOscillator();
    const osc2 = this.ctx.createOscillator();
    const filter = this.ctx.createBiquadFilter();
    const env = this.ctx.createGain();

    osc1.type = 'sine';
    osc2.type = 'triangle';
    safeSetValue(osc1.frequency, 210, start, 80, 4000);
    safeExpRamp(osc1.frequency, 660, start + 0.42, 80, 4000);
    safeExpRamp(osc1.frequency, 440, start + 0.72, 80, 4000);

    safeSetValue(osc2.frequency, 315, start, 80, 4000);
    safeExpRamp(osc2.frequency, 990, start + 0.42, 80, 4000);
    safeExpRamp(osc2.frequency, 660, start + 0.72, 80, 4000);

    filter.type = 'lowpass';
    filter.frequency.value = 2600;

    safeSetValue(env.gain, 0.0001, start, 0.0001, 1);
    safeLinearRamp(env.gain, 0.14, start + 0.14, 0, 1);
    safeExpRamp(env.gain, 0.0005, start + 0.78, 0.0001, 1);

    osc1.connect(filter);
    osc2.connect(filter);
    filter.connect(env);
    env.connect(this.exhaustMixBus);

    osc1.start(start);
    osc2.start(start);
    scheduleStop(osc1, start + 0.82, [filter, env]);
    scheduleStop(osc2, start + 0.82);
  }
}
