import {
  clampFinite,
  createBrassHornCurve,
  createLoopingNoise,
  lerpClamped,
  normalizeDriveSurface,
  safeExpRamp,
  safeLinearRamp,
  safeSetTarget,
  safeSetValue,
  scheduleStop,
  type AudioNoiseBank,
} from './dsp';
import type { DriveAudioFrame } from './types';

/**
 * Continuous open-world driving foley synthesizer:
 * - Dual-band resonant tire screech & drift howl
 * - Surface-aware tire roll (asphalt hum, concrete joints, gravel crunch + pebbles, grass brush)
 * - Speed-cubed aerodynamic wind rush (camera-aware boost for hood/bumper views)
 * - Subtle carbon-ceramic brake whisper
 * - Dual-tone brass-saturated automotive horn (415 Hz + 523.25 Hz)
 * - Suspension touchdown thump after jumps
 * - Subtle California coastal/canyon outdoor breeze bed
 */
export class DrivingFoleySynth {
  private readonly ctx: AudioContext;
  private readonly noise: AudioNoiseBank;
  private readonly output: GainNode;
  private readonly driveGateGain: GainNode;

  // Tire screech / drift howl
  private readonly screechNoise1: AudioBufferSourceNode;
  private readonly screechNoise2: AudioBufferSourceNode;
  private readonly screechBp1: BiquadFilterNode;
  private readonly screechBp2: BiquadFilterNode;
  private readonly screechToneOsc: OscillatorNode;
  private readonly screechToneGain: GainNode;
  private readonly screechGain: GainNode;

  // Surface tire roll
  private readonly rollLowNoise: AudioBufferSourceNode;
  private readonly rollLowFilter: BiquadFilterNode;
  private readonly rollLowGain: GainNode;

  private readonly rollMidNoise: AudioBufferSourceNode;
  private readonly rollMidFilter: BiquadFilterNode;
  private readonly rollMidGain: GainNode;

  private readonly gravelNoise: AudioBufferSourceNode;
  private readonly gravelFilter: BiquadFilterNode;
  private readonly gravelGain: GainNode;

  // Aerodynamic wind rush
  private readonly windLowNoise: AudioBufferSourceNode;
  private readonly windLowFilter: BiquadFilterNode;
  private readonly windLowGain: GainNode;

  private readonly windHighNoise: AudioBufferSourceNode;
  private readonly windHighFilter: BiquadFilterNode;
  private readonly windHighGain: GainNode;

  // Carbon-ceramic brake squeal
  private readonly brakeNoise: AudioBufferSourceNode;
  private readonly brakeFilter: BiquadFilterNode;
  private readonly brakeGain: GainNode;

  // Coastal/canyon outdoor breeze ambience
  private readonly breezeNoise: AudioBufferSourceNode;
  private readonly breezeFilter: BiquadFilterNode;
  private readonly breezeLfo: OscillatorNode;
  private readonly breezeLfoGain: GainNode;
  private readonly breezeGain: GainNode;

  // Dual-tone automotive horn
  private readonly hornOsc1: OscillatorNode;
  private readonly hornOsc2: OscillatorNode;
  private readonly hornShaper: WaveShaperNode;
  private readonly hornBandpass: BiquadFilterNode;
  private readonly hornLowpass: BiquadFilterNode;
  private readonly hornGain: GainNode;

  private active = false;
  private hornOn = false;
  private disposed = false;

  // Procedural distance/transition trackers
  private pebbleTimer = 0.08;
  private concreteJointDist = 0;
  private wasAirborne = false;
  private airborneSeconds = 0;

  constructor(ctx: AudioContext, destination: AudioNode, noise: AudioNoiseBank) {
    this.ctx = ctx;
    this.noise = noise;
    const now = ctx.currentTime;

    this.output = ctx.createGain();
    this.output.gain.value = 1;
    this.output.connect(destination);

    this.driveGateGain = ctx.createGain();
    this.driveGateGain.gain.value = 0;
    this.driveGateGain.connect(this.output);

    // 1. Tire Screech / Drift Howl (dual resonant bands + rubber tonal slip oscillator)
    this.screechGain = ctx.createGain();
    this.screechGain.gain.value = 0;
    this.screechGain.connect(this.driveGateGain);

    this.screechBp1 = ctx.createBiquadFilter();
    this.screechBp1.type = 'bandpass';
    this.screechBp1.frequency.value = 840;
    this.screechBp1.Q.value = 6.2;
    this.screechBp1.connect(this.screechGain);
    this.screechNoise1 = createLoopingNoise(ctx, noise.white, this.screechBp1);

    this.screechBp2 = ctx.createBiquadFilter();
    this.screechBp2.type = 'bandpass';
    this.screechBp2.frequency.value = 1580;
    this.screechBp2.Q.value = 7.8;
    this.screechBp2.connect(this.screechGain);
    this.screechNoise2 = createLoopingNoise(ctx, noise.pink, this.screechBp2, 1.25);

    this.screechToneGain = ctx.createGain();
    this.screechToneGain.gain.value = 0.14;
    this.screechToneGain.connect(this.screechGain);

    this.screechToneOsc = ctx.createOscillator();
    this.screechToneOsc.type = 'triangle';
    this.screechToneOsc.frequency.value = 920;
    this.screechToneOsc.connect(this.screechToneGain);
    this.screechToneOsc.start(now);

    // 2. Surface Tire Roll
    this.rollLowFilter = ctx.createBiquadFilter();
    this.rollLowFilter.type = 'lowpass';
    this.rollLowFilter.frequency.value = 210;
    this.rollLowFilter.Q.value = 0.9;
    this.rollLowGain = ctx.createGain();
    this.rollLowGain.gain.value = 0;
    this.rollLowFilter.connect(this.rollLowGain);
    this.rollLowGain.connect(this.driveGateGain);
    this.rollLowNoise = createLoopingNoise(ctx, noise.brown, this.rollLowFilter);

    this.rollMidFilter = ctx.createBiquadFilter();
    this.rollMidFilter.type = 'bandpass';
    this.rollMidFilter.frequency.value = 540;
    this.rollMidFilter.Q.value = 1.2;
    this.rollMidGain = ctx.createGain();
    this.rollMidGain.gain.value = 0;
    this.rollMidFilter.connect(this.rollMidGain);
    this.rollMidGain.connect(this.driveGateGain);
    this.rollMidNoise = createLoopingNoise(ctx, noise.pink, this.rollMidFilter);

    this.gravelFilter = ctx.createBiquadFilter();
    this.gravelFilter.type = 'bandpass';
    this.gravelFilter.frequency.value = 2100;
    this.gravelFilter.Q.value = 1.1;
    this.gravelGain = ctx.createGain();
    this.gravelGain.gain.value = 0;
    this.gravelFilter.connect(this.gravelGain);
    this.gravelGain.connect(this.driveGateGain);
    this.gravelNoise = createLoopingNoise(ctx, noise.crackle, this.gravelFilter);

    // 3. Wind & Aero Rush
    this.windLowFilter = ctx.createBiquadFilter();
    this.windLowFilter.type = 'bandpass';
    this.windLowFilter.frequency.value = 280;
    this.windLowFilter.Q.value = 0.85;
    this.windLowGain = ctx.createGain();
    this.windLowGain.gain.value = 0;
    this.windLowFilter.connect(this.windLowGain);
    this.windLowGain.connect(this.driveGateGain);
    this.windLowNoise = createLoopingNoise(ctx, noise.pink, this.windLowFilter);

    this.windHighFilter = ctx.createBiquadFilter();
    this.windHighFilter.type = 'bandpass';
    this.windHighFilter.frequency.value = 1450;
    this.windHighFilter.Q.value = 1.1;
    this.windHighGain = ctx.createGain();
    this.windHighGain.gain.value = 0;
    this.windHighFilter.connect(this.windHighGain);
    this.windHighGain.connect(this.driveGateGain);
    this.windHighNoise = createLoopingNoise(ctx, noise.white, this.windHighFilter);

    // 4. Subtle Carbon-Ceramic Brake Whisper
    this.brakeFilter = ctx.createBiquadFilter();
    this.brakeFilter.type = 'bandpass';
    this.brakeFilter.frequency.value = 2950;
    this.brakeFilter.Q.value = 12;
    this.brakeGain = ctx.createGain();
    this.brakeGain.gain.value = 0;
    this.brakeFilter.connect(this.brakeGain);
    this.brakeGain.connect(this.driveGateGain);
    this.brakeNoise = createLoopingNoise(ctx, noise.white, this.brakeFilter);

    // 5. California Coastal/Canyon Outdoor Breeze Ambience
    this.breezeFilter = ctx.createBiquadFilter();
    this.breezeFilter.type = 'bandpass';
    this.breezeFilter.frequency.value = 460;
    this.breezeFilter.Q.value = 0.9;
    this.breezeGain = ctx.createGain();
    this.breezeGain.gain.value = 0;
    this.breezeFilter.connect(this.breezeGain);
    this.breezeGain.connect(this.driveGateGain);
    this.breezeNoise = createLoopingNoise(ctx, noise.pink, this.breezeFilter, 0.72);

    this.breezeLfoGain = ctx.createGain();
    this.breezeLfoGain.gain.value = 165;
    this.breezeLfoGain.connect(this.breezeFilter.frequency);

    this.breezeLfo = ctx.createOscillator();
    this.breezeLfo.type = 'sine';
    this.breezeLfo.frequency.value = 0.14;
    this.breezeLfo.connect(this.breezeLfoGain);
    this.breezeLfo.start(now);

    // 6. Dual-Tone Automotive Horn (G#4 415.3 Hz + C5 523.25 Hz -> Brass Waveshaper)
    this.hornGain = ctx.createGain();
    this.hornGain.gain.value = 0;
    this.hornGain.connect(this.output);

    this.hornLowpass = ctx.createBiquadFilter();
    this.hornLowpass.type = 'lowpass';
    this.hornLowpass.frequency.value = 3400;
    this.hornLowpass.connect(this.hornGain);

    this.hornBandpass = ctx.createBiquadFilter();
    this.hornBandpass.type = 'peaking';
    this.hornBandpass.frequency.value = 1120;
    this.hornBandpass.Q.value = 1.4;
    this.hornBandpass.gain.value = 6.0;
    this.hornBandpass.connect(this.hornLowpass);

    this.hornShaper = ctx.createWaveShaper();
    this.hornShaper.curve = createBrassHornCurve();
    this.hornShaper.oversample = '2x';
    this.hornShaper.connect(this.hornBandpass);

    this.hornOsc1 = ctx.createOscillator();
    this.hornOsc1.type = 'sawtooth';
    this.hornOsc1.frequency.value = 415.3;
    this.hornOsc1.connect(this.hornShaper);
    this.hornOsc1.start(now);

    this.hornOsc2 = ctx.createOscillator();
    this.hornOsc2.type = 'sawtooth';
    this.hornOsc2.frequency.value = 523.25;
    this.hornOsc2.connect(this.hornShaper);
    this.hornOsc2.start(now);
  }

  /** Enables or smoothly fades out all open-world driving foley layers. */
  setActive(active: boolean): void {
    if (this.disposed) return;
    this.active = active;
    const now = this.ctx.currentTime;
    safeSetTarget(this.driveGateGain.gain, active ? 1 : 0, now, active ? 0.06 : 0.07, 0, 1);
    if (!active) {
      this.setHorn(false);
      this.wasAirborne = false;
      this.airborneSeconds = 0;
    } else {
      safeSetTarget(this.breezeGain.gain, 0.042, now, 0.12, 0, 0.2);
    }
  }

  /** Toggles the classic dual-tone automotive horn cleanly. */
  setHorn(active: boolean): void {
    if (this.disposed) return;
    const next = Boolean(active);
    if (next === this.hornOn) return;
    this.hornOn = next;
    const now = this.ctx.currentTime;
    safeSetTarget(this.hornGain.gain, next ? 0.24 : 0, now, next ? 0.012 : 0.028, 0, 0.5);
  }

  /** Per-frame update driven by live open-world vehicle telemetry. */
  update(frame: DriveAudioFrame): void {
    if (this.disposed || !this.active) return;

    const now = this.ctx.currentTime;
    const dt = clampFinite(frame.dt, 0.001, 0.1, 1 / 60);
    const speedMps = clampFinite(Math.abs(frame.speedMps), 0, 140, 0);
    const slip = clampFinite(frame.slipRatio, 0, 2, 0);
    const load = clampFinite(frame.wheelLoad, 0, 2, 1);
    const brake = clampFinite(frame.brake, 0, 1, 0);
    const airborne = Boolean(frame.airborne);
    const handbrake = Boolean(frame.handbrake);
    const surface = normalizeDriveSurface(frame.surface);

    // Sync horn directly from frame
    this.setHorn(Boolean(frame.hornActive));

    // Suspension landing thump when touching down from air
    if (airborne) {
      this.airborneSeconds += dt;
    } else if (this.wasAirborne && this.airborneSeconds >= 0.14) {
      const impactScale = clampFinite(this.airborneSeconds * 1.4, 0.25, 1, 0.5);
      this.playLandingThud(impactScale);
      this.airborneSeconds = 0;
    } else {
      this.airborneSeconds = 0;
    }
    this.wasAirborne = airborne;

    const grounded = airborne ? 0 : clampFinite(0.35 + load * 0.65, 0.2, 1.35, 1);
    const speedNorm = clampFinite(speedMps / 60, 0, 1.6, 0);

    // 1. Tire Screech / Drift Howl
    const effectiveSlip = Math.max(slip, handbrake && speedMps > 2.2 ? 0.85 : 0);
    const surfaceSquealFactor =
      surface === 'asphalt' ? 1.0 : surface === 'concrete' ? 1.12 : surface === 'gravel' ? 0.14 : 0.05;
    const slipAboveThreshold = clampFinite((effectiveSlip - 0.24) / 0.76, 0, 1, 0);
    const speedSquealFactor = clampFinite((speedMps - 1.4) / 8.5, 0, 1, 0);
    const screechLevel = grounded * surfaceSquealFactor * Math.pow(slipAboveThreshold, 1.15) * speedSquealFactor * 0.28;

    const screechPitchShift = lerpClamped(0.86, 1.24, clampFinite(speedMps / 45, 0, 1, 0.3) * 0.65 + slipAboveThreshold * 0.35);
    safeSetTarget(this.screechBp1.frequency, 810 * screechPitchShift, now, 0.03, 450, 1800);
    safeSetTarget(this.screechBp2.frequency, 1540 * screechPitchShift, now, 0.03, 900, 3200);
    safeSetTarget(this.screechToneOsc.frequency, 905 * screechPitchShift, now, 0.03, 500, 2100);
    safeSetTarget(this.screechGain.gain, screechLevel, now, 0.035, 0, 0.42);

    // 2. Surface Tire Roll & Procedural Surface Details
    const rollBase = grounded * clampFinite(speedMps / 35, 0, 1.35, 0);
    let lowCutoff = 210;
    let lowLevel = rollBase * 0.14;
    let midFreq = 520;
    let midLevel = rollBase * 0.065;
    let gravelLevel = 0;

    if (surface === 'asphalt') {
      lowCutoff = lerpClamped(140, 340, speedNorm);
      midFreq = lerpClamped(380, 920, speedNorm);
      lowLevel = rollBase * 0.13;
      midLevel = rollBase * 0.055;
      gravelLevel = rollBase * 0.008;
    } else if (surface === 'concrete') {
      lowCutoff = lerpClamped(190, 420, speedNorm);
      midFreq = lerpClamped(520, 1280, speedNorm);
      lowLevel = rollBase * 0.15;
      midLevel = rollBase * 0.095;
      gravelLevel = rollBase * 0.012;

      // Periodic concrete bridge/highway expansion joints (~every 14m)
      if (!airborne && speedMps > 4) {
        this.concreteJointDist += speedMps * dt;
        if (this.concreteJointDist >= 14.5) {
          this.concreteJointDist -= 14.5;
          this.playConcreteJointThump(clampFinite(speedMps / 45, 0.25, 1, 0.4));
        }
      }
    } else if (surface === 'gravel') {
      lowCutoff = lerpClamped(180, 380, speedNorm);
      midFreq = lerpClamped(650, 1550, speedNorm);
      lowLevel = rollBase * 0.16;
      midLevel = rollBase * 0.11;
      gravelLevel = grounded * clampFinite((speedMps / 22) * (1 + slip * 0.9), 0, 1.4, 0) * 0.22;

      // Scattered stone/pebble wheel-well pings
      if (!airborne && speedMps > 2.2) {
        this.pebbleTimer -= dt * clampFinite(speedMps / 10, 0.5, 4.5, 1);
        if (this.pebbleTimer <= 0) {
          this.playPebblePing(clampFinite(speedMps / 26 + slip * 0.35, 0.18, 1, 0.35));
          this.pebbleTimer = 0.055 + Math.random() * 0.16;
        }
      }
    } else {
      // Grass: soft muffled brushy rustle
      lowCutoff = lerpClamped(130, 260, speedNorm);
      midFreq = lerpClamped(900, 2100, speedNorm);
      lowLevel = rollBase * 0.12;
      midLevel = rollBase * 0.095;
      gravelLevel = grounded * clampFinite((speedMps / 26) * (0.65 + slip * 0.8), 0, 1, 0) * 0.09;
    }

    safeSetTarget(this.rollLowFilter.frequency, lowCutoff, now, 0.05, 80, 800);
    safeSetTarget(this.rollLowGain.gain, lowLevel, now, 0.045, 0, 0.35);
    safeSetTarget(this.rollMidFilter.frequency, midFreq, now, 0.05, 220, 3000);
    safeSetTarget(this.rollMidGain.gain, midLevel, now, 0.045, 0, 0.28);
    safeSetTarget(this.gravelFilter.frequency, surface === 'grass' ? 2800 : 1950, now, 0.05, 800, 4800);
    safeSetTarget(this.gravelGain.gain, gravelLevel, now, 0.045, 0, 0.38);

    // 3. Wind & Aero Rush (scales with speedMps^2.5, boosted in hood/bumper cameras)
    const camWindBoost =
      frame.cameraMode === 'hood' || frame.cameraMode === 'bumper'
        ? 1.48
        : frame.cameraMode === 'chase-far'
          ? 0.82
          : 1.0;
    const windCurve = Math.pow(clampFinite(speedMps / 54, 0, 1.7, 0), 2.5);
    const windLowLevel = clampFinite(windCurve * 0.22 * camWindBoost, 0, 0.38, 0);
    const windHighLevel = clampFinite(windCurve * 0.14 * camWindBoost, 0, 0.26, 0);

    safeSetTarget(this.windLowFilter.frequency, lerpClamped(170, 540, clampFinite(speedMps / 75, 0, 1, 0)), now, 0.06, 120, 900);
    safeSetTarget(this.windHighFilter.frequency, lerpClamped(850, 3300, clampFinite(speedMps / 75, 0, 1, 0)), now, 0.06, 500, 5000);
    safeSetTarget(this.windLowGain.gain, windLowLevel, now, 0.055, 0, 0.42);
    safeSetTarget(this.windHighGain.gain, windHighLevel, now, 0.055, 0, 0.32);

    // 4. Subtle Carbon-Ceramic Brake Whisper
    const brakeSpeedWindow = speedMps > 3 && speedMps < 32 ? clampFinite(1 - Math.abs(speedMps - 14) / 18, 0, 1, 0) : 0;
    const brakeSqueal = grounded * brakeSpeedWindow * clampFinite((brake - 0.5) / 0.5, 0, 1, 0) * 0.032;
    safeSetTarget(this.brakeFilter.frequency, lerpClamped(2650, 3250, brake), now, 0.04, 1800, 4500);
    safeSetTarget(this.brakeGain.gain, brakeSqueal, now, 0.04, 0, 0.08);

    // 5. Outdoor California Coastal / Canyon Breeze (gently ducks as speed wind takes over)
    const breezeLevel = lerpClamped(0.044, 0.012, clampFinite(speedMps / 30, 0, 1, 0));
    safeSetTarget(this.breezeGain.gain, breezeLevel, now, 0.12, 0, 0.12);
  }

  /** Stops all continuous sources and cleans up nodes. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.active = false;
    this.hornOn = false;
    const now = this.ctx.currentTime;

    const sources: AudioScheduledSourceNode[] = [
      this.screechNoise1,
      this.screechNoise2,
      this.screechToneOsc,
      this.rollLowNoise,
      this.rollMidNoise,
      this.gravelNoise,
      this.windLowNoise,
      this.windHighNoise,
      this.brakeNoise,
      this.breezeNoise,
      this.breezeLfo,
      this.hornOsc1,
      this.hornOsc2,
    ];
    for (const src of sources) {
      try {
        src.stop(now + 0.01);
        src.disconnect();
      } catch {
        // Ignore already-stopped nodes.
      }
    }
    try {
      this.output.disconnect();
    } catch {
      // Already disconnected.
    }
  }

  // ------------------------------------------------------------------ micro foley events

  private playPebblePing(intensity: number): void {
    const now = this.ctx.currentTime;
    const osc = this.ctx.createOscillator();
    const g = this.ctx.createGain();
    osc.type = 'triangle';
    const f = 1400 + Math.random() * 2400;
    safeSetValue(osc.frequency, f, now, 400, 6000);
    safeExpRamp(osc.frequency, f * 0.55, now + 0.025, 200, 6000);

    safeSetValue(g.gain, 0.0001, now, 0.0001, 0.5);
    safeLinearRamp(g.gain, 0.045 * intensity, now + 0.002, 0, 0.4);
    safeExpRamp(g.gain, 0.0004, now + 0.028, 0.0001, 0.4);

    osc.connect(g);
    g.connect(this.driveGateGain);
    osc.start(now);
    scheduleStop(osc, now + 0.032, [g]);
  }

  private playConcreteJointThump(intensity: number): void {
    const now = this.ctx.currentTime;
    // Front & rear axle double-thump
    const delays = [0, 0.055];
    for (const d of delays) {
      const t = now + d;
      const osc = this.ctx.createOscillator();
      const g = this.ctx.createGain();
      osc.type = 'sine';
      safeSetValue(osc.frequency, 88, t, 30, 300);
      safeExpRamp(osc.frequency, 42, t + 0.045, 25, 300);

      safeSetValue(g.gain, 0.0001, t, 0.0001, 0.5);
      safeLinearRamp(g.gain, 0.065 * intensity, t + 0.005, 0, 0.4);
      safeExpRamp(g.gain, 0.0004, t + 0.05, 0.0001, 0.4);

      osc.connect(g);
      g.connect(this.driveGateGain);
      osc.start(t);
      scheduleStop(osc, t + 0.058, [g]);
    }
  }

  private playLandingThud(intensity: number): void {
    const now = this.ctx.currentTime;
    const strength = clampFinite(intensity, 0.2, 1, 0.5);

    const osc = this.ctx.createOscillator();
    const g = this.ctx.createGain();
    osc.type = 'sine';
    safeSetValue(osc.frequency, 110, now, 30, 300);
    safeExpRamp(osc.frequency, 36, now + 0.14, 24, 300);

    safeSetValue(g.gain, 0.0001, now, 0.0001, 1);
    safeLinearRamp(g.gain, 0.28 * strength, now + 0.008, 0, 0.6);
    safeExpRamp(g.gain, 0.0005, now + 0.17, 0.0001, 0.6);

    osc.connect(g);
    g.connect(this.driveGateGain);
    osc.start(now);
    scheduleStop(osc, now + 0.185, [g]);

    // Tire scrub puff on touchdown
    const puff = this.ctx.createBufferSource();
    puff.buffer = this.noise.pink;
    const lp = this.ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 640;
    const pg = this.ctx.createGain();
    safeSetValue(pg.gain, 0.0001, now, 0.0001, 1);
    safeLinearRamp(pg.gain, 0.12 * strength, now + 0.01, 0, 0.4);
    safeExpRamp(pg.gain, 0.0005, now + 0.12, 0.0001, 0.4);

    puff.connect(lp);
    lp.connect(pg);
    pg.connect(this.driveGateGain);
    puff.start(now);
    scheduleStop(puff, now + 0.135, [lp, pg]);
  }
}
