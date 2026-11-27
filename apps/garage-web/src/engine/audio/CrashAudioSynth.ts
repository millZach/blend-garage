import {
  clampFinite,
  createLoopingNoise,
  createMetalCrunchCurve,
  lerpClamped,
  safeExpRamp,
  safeLinearRamp,
  safeSetTarget,
  safeSetValue,
  scheduleStop,
  type AudioNoiseBank,
} from './dsp';
import type { CrashAudioEvent } from './types';

/**
 * Event-driven crash, sheet-metal deformation, glass shatter, tumbling debris,
 * continuous metallic guardrail scrape, pit-stop pneumatic repair, and road reset synth.
 */
export class CrashAudioSynth {
  private readonly ctx: AudioContext;
  private readonly noise: AudioNoiseBank;
  private readonly output: GainNode;
  private readonly crunchCurve: Float32Array<ArrayBuffer>;

  // Continuous metal-on-guardrail / asphalt scrape network
  private readonly scrapeGain: GainNode;
  private readonly scrapeShaper: WaveShaperNode;
  private readonly scrapeNoise: AudioBufferSourceNode;
  private readonly scrapeBp: BiquadFilterNode;
  private readonly scrapeSparkNoise: AudioBufferSourceNode;
  private readonly scrapeHp: BiquadFilterNode;
  private readonly scrapeToneOsc: OscillatorNode;
  private readonly scrapeFmOsc: OscillatorNode;
  private readonly scrapeFmGain: GainNode;
  private readonly scrapeToneGain: GainNode;

  private lastImpactTime = -10;
  private lastImpactSeverity = 0;
  private disposed = false;

  constructor(ctx: AudioContext, destination: AudioNode, noise: AudioNoiseBank) {
    this.ctx = ctx;
    this.noise = noise;
    this.crunchCurve = createMetalCrunchCurve();
    const now = ctx.currentTime;

    this.output = ctx.createGain();
    this.output.gain.value = 1;
    this.output.connect(destination);

    // Continuous metallic scrape chain
    this.scrapeGain = ctx.createGain();
    this.scrapeGain.gain.value = 0;
    this.scrapeGain.connect(this.output);

    this.scrapeShaper = ctx.createWaveShaper();
    this.scrapeShaper.curve = this.crunchCurve;
    this.scrapeShaper.connect(this.scrapeGain);

    this.scrapeBp = ctx.createBiquadFilter();
    this.scrapeBp.type = 'bandpass';
    this.scrapeBp.frequency.value = 1850;
    this.scrapeBp.Q.value = 3.2;
    this.scrapeBp.connect(this.scrapeShaper);
    this.scrapeNoise = createLoopingNoise(ctx, noise.white, this.scrapeBp);

    this.scrapeHp = ctx.createBiquadFilter();
    this.scrapeHp.type = 'highpass';
    this.scrapeHp.frequency.value = 2800;
    this.scrapeHp.connect(this.scrapeShaper);
    this.scrapeSparkNoise = createLoopingNoise(ctx, noise.crackle, this.scrapeHp, 1.35);

    // FM metallic screech resonator for guardrail grinding
    this.scrapeToneGain = ctx.createGain();
    this.scrapeToneGain.gain.value = 0.16;
    this.scrapeToneGain.connect(this.scrapeShaper);

    this.scrapeToneOsc = ctx.createOscillator();
    this.scrapeToneOsc.type = 'sawtooth';
    this.scrapeToneOsc.frequency.value = 1280;
    this.scrapeToneOsc.connect(this.scrapeToneGain);
    this.scrapeToneOsc.start(now);

    this.scrapeFmGain = ctx.createGain();
    this.scrapeFmGain.gain.value = 290;
    this.scrapeFmGain.connect(this.scrapeToneOsc.frequency);

    this.scrapeFmOsc = ctx.createOscillator();
    this.scrapeFmOsc.type = 'sine';
    this.scrapeFmOsc.frequency.value = 94;
    this.scrapeFmOsc.connect(this.scrapeFmGain);
    this.scrapeFmOsc.start(now);
  }

  /**
   * Plays a layered, G-force-scaled crash impact:
   * - Sub-bass structural boom
   * - Staggered crumpled sheet-metal crunch bursts
   * - Inharmonic ringing metallic body resonators
   * - Rolling post-impact debris clatter
   * - Sparkling high-frequency glass shatter (when `glassBreak` or `gForce >= 18`)
   * - Detached panel tumble (when `panelDetached`)
   */
  playImpact(event: CrashAudioEvent): void {
    if (this.disposed) return;

    const now = this.ctx.currentTime;
    const gForce = clampFinite(event.gForce, 0, 120, 0);
    const speedMps = clampFinite(Math.abs(event.speedMps), 0, 140, 0);
    if (gForce < 0.8 && speedMps < 1.2) return;

    const gNorm = clampFinite(gForce / 28, 0.12, 1, 0.2);
    const speedNorm = clampFinite(speedMps / 32, 0.1, 1, 0.2);
    const severity = clampFinite(gNorm * 0.75 + speedNorm * 0.25, 0.12, 1, 0.25);

    // Guard against multi-contact physics solver bursts on the same millisecond
    if (now - this.lastImpactTime < 0.045 && severity <= this.lastImpactSeverity * 1.15) {
      return;
    }
    this.lastImpactTime = now;
    this.lastImpactSeverity = severity;

    const metallic = event.metallic !== false;
    const shatterGlass = Boolean(event.glassBreak) || gForce >= 18;

    // 1. Sub-Bass Structural Boom + Punch Transient
    this.triggerSubBoom(now, severity);

    // 2. Crumpled Sheet-Metal Bandpass Crunch Bursts
    this.triggerSheetMetalCrunch(now, severity, metallic);

    // 3. Ringing Metallic Body Resonators
    if (metallic) {
      this.triggerMetallicResonators(now, severity);
    }

    // 4. Rolling Post-Impact Debris Clatter
    if (severity >= 0.22) {
      this.triggerDebrisClatter(now + 0.08, severity);
    }

    // 5. Glass Shatter Cascade
    if (shatterGlass) {
      this.triggerGlassShatter(now + 0.015, clampFinite(Math.max(severity, 0.55), 0.4, 1, 0.7));
    }

    // 6. Panel Detach Tumble
    if (event.panelDetached) {
      this.playPartDetach();
    }
  }

  /** Plays a realistic tumbling metal/plastic bumper or hood bounce sequence. */
  playPartDetach(): void {
    if (this.disposed) return;
    const now = this.ctx.currentTime;

    // Physics-like decaying bounce intervals
    const bounces = [
      { delay: 0.0, amp: 0.34, pitch: 1.0 },
      { delay: 0.18, amp: 0.25, pitch: 1.08 },
      { delay: 0.32, amp: 0.17, pitch: 1.16 },
      { delay: 0.43, amp: 0.11, pitch: 1.25 },
      { delay: 0.51, amp: 0.07, pitch: 1.32 },
    ];

    for (const b of bounces) {
      const t = now + b.delay;
      // Hollow metallic/composite panel clang
      const osc = this.ctx.createOscillator();
      const osc2 = this.ctx.createOscillator();
      const bp = this.ctx.createBiquadFilter();
      const g = this.ctx.createGain();

      osc.type = 'triangle';
      osc2.type = 'square';
      const base = (240 + Math.random() * 90) * b.pitch;
      safeSetValue(osc.frequency, base, t, 60, 2000);
      safeExpRamp(osc.frequency, base * 0.65, t + 0.09, 40, 2000);
      safeSetValue(osc2.frequency, base * 1.73, t, 80, 3500);
      safeExpRamp(osc2.frequency, base * 1.22, t + 0.075, 60, 3500);

      bp.type = 'bandpass';
      bp.frequency.value = base * 2.2;
      bp.Q.value = 1.6;

      safeSetValue(g.gain, 0.0001, t, 0.0001, 1);
      safeLinearRamp(g.gain, b.amp * 0.55, t + 0.004, 0, 0.8);
      safeExpRamp(g.gain, 0.0005, t + 0.11, 0.0001, 0.8);

      osc.connect(bp);
      osc2.connect(bp);
      bp.connect(g);
      g.connect(this.output);

      osc.start(t);
      osc2.start(t);
      scheduleStop(osc, t + 0.125, [bp, g]);
      scheduleStop(osc2, t + 0.125);

      // Asphalt scrape clatter on bounce
      const scrape = this.ctx.createBufferSource();
      scrape.buffer = this.noise.crackle;
      const hp = this.ctx.createBiquadFilter();
      hp.type = 'bandpass';
      hp.frequency.value = 1600 + Math.random() * 900;
      hp.Q.value = 1.8;
      const sg = this.ctx.createGain();
      safeSetValue(sg.gain, 0.0001, t, 0.0001, 1);
      safeLinearRamp(sg.gain, b.amp * 0.45, t + 0.005, 0, 0.8);
      safeExpRamp(sg.gain, 0.0005, t + 0.08, 0.0001, 0.8);

      scrape.connect(hp);
      hp.connect(sg);
      sg.connect(this.output);
      scrape.start(t);
      scheduleStop(scrape, t + 0.09, [hp, sg]);
    }
  }

  /** Updates continuous screeching metal-on-guardrail / asphalt scrape noise. */
  updateScrape(intensity: number, speedMps: number): void {
    if (this.disposed) return;
    const now = this.ctx.currentTime;
    const safeIntensity = clampFinite(intensity, 0, 1, 0);
    const safeSpeed = clampFinite(Math.abs(speedMps), 0, 120, 0);

    if (safeIntensity <= 0.015 || safeSpeed < 0.45) {
      safeSetTarget(this.scrapeGain.gain, 0, now, 0.045, 0, 0.5);
      return;
    }

    const speedFactor = clampFinite(safeSpeed / 20, 0.15, 1.25, 0.3);
    const level = clampFinite(safeIntensity * speedFactor * 0.24, 0, 0.34, 0);
    const pitchBase = lerpClamped(980, 2650, clampFinite(safeSpeed / 36, 0, 1, 0.4));

    safeSetTarget(this.scrapeBp.frequency, pitchBase, now, 0.03, 600, 4200);
    safeSetTarget(this.scrapeToneOsc.frequency, pitchBase * 0.72, now, 0.03, 450, 3200);
    safeSetTarget(this.scrapeFmOsc.frequency, lerpClamped(58, 165, speedFactor), now, 0.04, 30, 240);
    safeSetTarget(this.scrapeGain.gain, level, now, 0.035, 0, 0.4);
  }

  /** Plays a pit-stop pneumatic air-wrench zip-zip + clean mechanical ready chime. */
  playRepair(): void {
    if (this.disposed) return;
    const now = this.ctx.currentTime;

    // Two crisp pneumatic impact-wrench bursts ("brrrt - brrrt")
    const bursts = [0.0, 0.19];
    for (let i = 0; i < bursts.length; i++) {
      this.triggerAirWrenchZip(now + bursts[i], 0.13, i === 0 ? 1.0 : 1.08);
    }

    // Pneumatic air exhaust hiss
    const hissStart = now + 0.34;
    const hiss = this.ctx.createBufferSource();
    hiss.buffer = this.noise.white;
    const hp = this.ctx.createBiquadFilter();
    hp.type = 'bandpass';
    hp.frequency.value = 3800;
    hp.Q.value = 1.4;
    const hg = this.ctx.createGain();
    safeSetValue(hg.gain, 0.0001, hissStart, 0.0001, 1);
    safeLinearRamp(hg.gain, 0.11, hissStart + 0.015, 0, 0.5);
    safeExpRamp(hg.gain, 0.0005, hissStart + 0.16, 0.0001, 0.5);
    hiss.connect(hp);
    hp.connect(hg);
    hg.connect(this.output);
    hiss.start(hissStart);
    scheduleStop(hiss, hissStart + 0.18, [hp, hg]);

    // Clean mechanical latch + rising ready chime
    this.triggerLatchChime(now + 0.36, 587.33, 880.0);
  }

  /** Plays a snappy hydraulic latch + clean reset tone when respawning on the road. */
  playReset(): void {
    if (this.disposed) return;
    const now = this.ctx.currentTime;
    this.triggerAirWrenchZip(now, 0.085, 1.15);
    this.triggerLatchChime(now + 0.095, 523.25, 783.99);
  }

  /** Silences and releases all continuous scrape nodes. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    const now = this.ctx.currentTime;
    const sources: AudioScheduledSourceNode[] = [
      this.scrapeNoise,
      this.scrapeSparkNoise,
      this.scrapeToneOsc,
      this.scrapeFmOsc,
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

  // ------------------------------------------------------------------ impact sub-layers

  private triggerSubBoom(start: number, severity: number): void {
    const dur = lerpClamped(0.18, 0.38, severity);
    const osc = this.ctx.createOscillator();
    const g = this.ctx.createGain();
    osc.type = 'sine';
    safeSetValue(osc.frequency, lerpClamped(95, 140, severity), start, 25, 400);
    safeExpRamp(osc.frequency, 28, start + dur, 20, 300);

    safeSetValue(g.gain, 0.0001, start, 0.0001, 1);
    safeLinearRamp(g.gain, 0.65 * severity, start + 0.006, 0, 1);
    safeExpRamp(g.gain, 0.0008, start + dur, 0.0001, 1);

    osc.connect(g);
    g.connect(this.output);
    osc.start(start);
    scheduleStop(osc, start + dur + 0.02, [g]);
  }

  private triggerSheetMetalCrunch(start: number, severity: number, metallic: boolean): void {
    const stages = severity > 0.5 ? [0, 0.032, 0.072] : [0, 0.036];
    for (let i = 0; i < stages.length; i++) {
      const t = start + stages[i];
      const stageScale = Math.pow(0.76, i) * severity;
      const dur = lerpClamped(0.12, 0.28, severity) * (1 - i * 0.14);

      const src = this.ctx.createBufferSource();
      src.buffer = i === 0 ? this.noise.white : this.noise.crackle;

      const bp = this.ctx.createBiquadFilter();
      bp.type = 'bandpass';
      const freqHi = (metallic ? 2100 : 1200) - i * 320 + Math.random() * 260;
      safeSetValue(bp.frequency, freqHi, t, 200, 6000);
      safeExpRamp(bp.frequency, Math.max(240, freqHi * 0.32), t + dur, 150, 5000);
      bp.Q.value = metallic ? 1.5 : 0.9;

      const shaper = this.ctx.createWaveShaper();
      shaper.curve = this.crunchCurve;

      const g = this.ctx.createGain();
      safeSetValue(g.gain, 0.0001, t, 0.0001, 1);
      safeLinearRamp(g.gain, 0.44 * stageScale, t + 0.006, 0, 1);
      safeExpRamp(g.gain, 0.0006, t + dur, 0.0001, 1);

      src.connect(bp);
      bp.connect(shaper);
      shaper.connect(g);
      g.connect(this.output);

      src.start(t);
      scheduleStop(src, t + dur + 0.03, [bp, shaper, g]);
    }
  }

  private triggerMetallicResonators(start: number, severity: number): void {
    // Inharmonic chassis sheet-metal resonant modes
    const partials = [445, 792, 1315, 2140];
    for (let i = 0; i < partials.length; i++) {
      const osc = this.ctx.createOscillator();
      const g = this.ctx.createGain();
      osc.type = i % 2 === 0 ? 'triangle' : 'sine';
      const f = partials[i] * (0.94 + Math.random() * 0.12);
      const dur = lerpClamped(0.18, 0.46, severity) * Math.pow(0.84, i);

      safeSetValue(osc.frequency, f, start, 100, 8000);
      safeExpRamp(osc.frequency, f * 0.91, start + dur, 80, 8000);

      safeSetValue(g.gain, 0.0001, start, 0.0001, 1);
      safeLinearRamp(g.gain, (0.14 / (i + 1)) * severity, start + 0.004, 0, 0.6);
      safeExpRamp(g.gain, 0.0004, start + dur, 0.0001, 0.6);

      osc.connect(g);
      g.connect(this.output);
      osc.start(start);
      scheduleStop(osc, start + dur + 0.02, [g]);
    }
  }

  private triggerDebrisClatter(start: number, severity: number): void {
    const count = Math.round(lerpClamped(3, 7, severity));
    for (let i = 0; i < count; i++) {
      const t = start + i * 0.068 + Math.random() * 0.055;
      const amp = Math.pow(0.8, i) * severity * 0.16;

      const src = this.ctx.createBufferSource();
      src.buffer = this.noise.crackle;
      const hp = this.ctx.createBiquadFilter();
      hp.type = 'bandpass';
      hp.frequency.value = 1800 + Math.random() * 3200;
      hp.Q.value = 3.2;

      const g = this.ctx.createGain();
      safeSetValue(g.gain, 0.0001, t, 0.0001, 1);
      safeLinearRamp(g.gain, amp, t + 0.003, 0, 0.6);
      safeExpRamp(g.gain, 0.0004, t + 0.055, 0.0001, 0.6);

      src.connect(hp);
      hp.connect(g);
      g.connect(this.output);
      src.start(t);
      scheduleStop(src, t + 0.065, [hp, g]);
    }
  }

  private triggerGlassShatter(start: number, severity: number): void {
    // Initial crystalline fracture burst
    const snap = this.ctx.createBufferSource();
    snap.buffer = this.noise.white;
    const hp = this.ctx.createBiquadFilter();
    hp.type = 'highpass';
    hp.frequency.value = 3400;
    const snapGain = this.ctx.createGain();
    safeSetValue(snapGain.gain, 0.0001, start, 0.0001, 1);
    safeLinearRamp(snapGain.gain, 0.24 * severity, start + 0.004, 0, 0.8);
    safeExpRamp(snapGain.gain, 0.0005, start + 0.16, 0.0001, 0.8);
    snap.connect(hp);
    hp.connect(snapGain);
    snapGain.connect(this.output);
    snap.start(start);
    scheduleStop(snap, start + 0.18, [hp, snapGain]);

    // Sparkling cascade of falling glass shards
    const shardCount = 9;
    for (let i = 0; i < shardCount; i++) {
      const t = start + 0.02 + i * 0.048 + Math.random() * 0.04;
      const osc = this.ctx.createOscillator();
      const g = this.ctx.createGain();
      osc.type = 'sine';
      const freq = 3400 + Math.random() * 5400;
      safeSetValue(osc.frequency, freq, t, 1500, 12000);
      safeExpRamp(osc.frequency, freq * 0.86, t + 0.085, 1000, 12000);

      const amp = Math.pow(0.86, i) * 0.075 * severity;
      safeSetValue(g.gain, 0.0001, t, 0.0001, 0.5);
      safeLinearRamp(g.gain, amp, t + 0.002, 0, 0.4);
      safeExpRamp(g.gain, 0.0003, t + 0.095, 0.0001, 0.4);

      osc.connect(g);
      g.connect(this.output);
      osc.start(t);
      scheduleStop(osc, t + 0.105, [g]);
    }
  }

  private triggerAirWrenchZip(start: number, duration: number, pitchMul: number): void {
    const carrier = this.ctx.createOscillator();
    const lfo = this.ctx.createOscillator();
    const lfoGain = this.ctx.createGain();
    const bp = this.ctx.createBiquadFilter();
    const g = this.ctx.createGain();

    carrier.type = 'sawtooth';
    safeSetValue(carrier.frequency, 460 * pitchMul, start, 100, 2000);
    safeExpRamp(carrier.frequency, 740 * pitchMul, start + duration, 100, 2500);

    // Rapid hammer anvil pulses (~38 Hz)
    lfo.type = 'square';
    lfo.frequency.value = 38 * pitchMul;
    lfoGain.gain.value = 0.09;

    bp.type = 'bandpass';
    bp.frequency.value = 1450 * pitchMul;
    bp.Q.value = 1.9;

    safeSetValue(g.gain, 0.0001, start, 0.0001, 1);
    safeLinearRamp(g.gain, 0.15, start + 0.012, 0, 0.6);
    safeLinearRamp(g.gain, 0.12, start + duration * 0.8, 0, 0.6);
    safeExpRamp(g.gain, 0.0005, start + duration + 0.02, 0.0001, 0.6);

    lfo.connect(lfoGain);
    lfoGain.connect(g.gain);
    carrier.connect(bp);
    bp.connect(g);
    g.connect(this.output);

    carrier.start(start);
    lfo.start(start);
    scheduleStop(carrier, start + duration + 0.03, [bp, g, lfoGain]);
    scheduleStop(lfo, start + duration + 0.03);
  }

  private triggerLatchChime(start: number, freqA: number, freqB: number): void {
    // Crisp mechanical latch click
    const latch = this.ctx.createOscillator();
    const lg = this.ctx.createGain();
    latch.type = 'triangle';
    safeSetValue(latch.frequency, 240, start, 60, 1000);
    safeExpRamp(latch.frequency, 92, start + 0.03, 40, 1000);
    safeSetValue(lg.gain, 0.0001, start, 0.0001, 1);
    safeLinearRamp(lg.gain, 0.14, start + 0.003, 0, 0.5);
    safeExpRamp(lg.gain, 0.0004, start + 0.04, 0.0001, 0.5);
    latch.connect(lg);
    lg.connect(this.output);
    latch.start(start);
    scheduleStop(latch, start + 0.048, [lg]);

    // Clean two-note confirmation chime
    const notes = [
      { f: freqA, delay: 0.015 },
      { f: freqB, delay: 0.085 },
    ];
    for (const n of notes) {
      const t = start + n.delay;
      const osc = this.ctx.createOscillator();
      const g = this.ctx.createGain();
      osc.type = 'sine';
      osc.frequency.value = n.f;
      safeSetValue(g.gain, 0.0001, t, 0.0001, 1);
      safeLinearRamp(g.gain, 0.095, t + 0.008, 0, 0.4);
      safeExpRamp(g.gain, 0.0004, t + 0.22, 0.0001, 0.4);
      osc.connect(g);
      g.connect(this.output);
      osc.start(t);
      scheduleStop(osc, t + 0.24, [g]);
    }
  }
}
