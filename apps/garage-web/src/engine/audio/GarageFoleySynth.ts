import {
  createLoopingNoise,
  safeExpRamp,
  safeLinearRamp,
  safeSetTarget,
  safeSetValue,
  scheduleStop,
  type AudioNoiseBank,
} from './dsp';
import type { AudioMode } from './types';

/**
 * Mechanics Shop, Photo Bay & UI foley synthesizer:
 * - HVLP paint spray-gun hiss
 * - Pneumatic impact wrench / socket ratchet part install & remove
 * - Multi-wrench stock reset sweep
 * - Crisp automotive relay light toggle
 * - Airy camera / bay swoosh
 * - Garage bay door rumble for car selection (paired with engine rev preview)
 * - Subtle tactile mechanical UI micro-click
 * - Unobtrusive indoor shop/showroom room tone + optional hydraulic 2-post lift hum
 */
export class GarageFoleySynth {
  private readonly ctx: AudioContext;
  private readonly noise: AudioNoiseBank;
  private readonly output: GainNode;

  // Subtle shop/showroom room tone
  private readonly roomNoise: AudioBufferSourceNode;
  private readonly roomFilter: BiquadFilterNode;
  private readonly hvacNoise: AudioBufferSourceNode;
  private readonly hvacFilter: BiquadFilterNode;
  private readonly roomGain: GainNode;

  // Hydraulic 2-post lift pump hum
  private readonly liftOsc1: OscillatorNode;
  private readonly liftOsc2: OscillatorNode;
  private readonly liftFilter: BiquadFilterNode;
  private readonly liftGain: GainNode;

  private mode: AudioMode = 'idle';
  private liftMoving = false;
  private lastSprayTime = -10;
  private lastClickTime = -10;
  private disposed = false;

  constructor(ctx: AudioContext, destination: AudioNode, noise: AudioNoiseBank) {
    this.ctx = ctx;
    this.noise = noise;
    const now = ctx.currentTime;

    this.output = ctx.createGain();
    this.output.gain.value = 1;
    this.output.connect(destination);

    // Subtle showroom/shop room tone (warm ventilation air, completely unobtrusive)
    this.roomGain = ctx.createGain();
    this.roomGain.gain.value = 0;
    this.roomGain.connect(this.output);

    this.roomFilter = ctx.createBiquadFilter();
    this.roomFilter.type = 'lowpass';
    this.roomFilter.frequency.value = 165;
    this.roomFilter.connect(this.roomGain);
    this.roomNoise = createLoopingNoise(ctx, noise.brown, this.roomFilter, 0.65);

    this.hvacFilter = ctx.createBiquadFilter();
    this.hvacFilter.type = 'bandpass';
    this.hvacFilter.frequency.value = 410;
    this.hvacFilter.Q.value = 1.1;
    const hvacTrim = ctx.createGain();
    hvacTrim.gain.value = 0.25;
    this.hvacFilter.connect(hvacTrim);
    hvacTrim.connect(this.roomGain);
    this.hvacNoise = createLoopingNoise(ctx, noise.pink, this.hvacFilter, 0.8);

    // Optional two-post hydraulic lift motor hum
    this.liftGain = ctx.createGain();
    this.liftGain.gain.value = 0;
    this.liftGain.connect(this.output);

    this.liftFilter = ctx.createBiquadFilter();
    this.liftFilter.type = 'lowpass';
    this.liftFilter.frequency.value = 380;
    this.liftFilter.Q.value = 1.2;
    this.liftFilter.connect(this.liftGain);

    this.liftOsc1 = ctx.createOscillator();
    this.liftOsc1.type = 'sawtooth';
    this.liftOsc1.frequency.value = 116;
    this.liftOsc1.connect(this.liftFilter);
    this.liftOsc1.start(now);

    this.liftOsc2 = ctx.createOscillator();
    this.liftOsc2.type = 'triangle';
    this.liftOsc2.frequency.value = 232;
    this.liftOsc2.connect(this.liftFilter);
    this.liftOsc2.start(now);
  }

  /** Transitions indoor shop room ambience cleanly between modes. */
  setMode(mode: AudioMode): void {
    if (this.disposed) return;
    this.mode = mode;
    const now = this.ctx.currentTime;
    const targetRoom = mode === 'shop' ? 0.034 : 0;
    safeSetTarget(this.roomGain.gain, targetRoom, now, 0.14, 0, 0.12);
    if (mode !== 'shop') {
      this.setLiftMoving(false);
    }
  }

  getMode(): AudioMode {
    return this.mode;
  }

  /** Smoothly engages or releases the subtle two-post hydraulic lift hum in the shop. */
  setLiftMoving(moving: boolean): void {
    if (this.disposed) return;
    const next = Boolean(moving) && this.mode === 'shop';
    if (next === this.liftMoving) return;
    this.liftMoving = next;
    const now = this.ctx.currentTime;
    safeSetTarget(this.liftGain.gain, next ? 0.055 : 0, now, next ? 0.04 : 0.06, 0, 0.15);
    this.playRelayMicroClick(now, next ? 0.055 : 0.04, next ? 1150 : 880);
  }

  /** Crisp HVLP automotive paint spray-gun hiss burst. */
  playPaintSpray(): void {
    if (this.disposed) return;
    const now = this.ctx.currentTime;
    // Throttle rapid continuous color-picker drags cleanly
    if (now - this.lastSprayTime < 0.095) return;
    this.lastSprayTime = now;

    // Trigger needle click
    this.playRelayMicroClick(now, 0.045, 2200);

    // Fine atomized mist spray
    const src = this.ctx.createBufferSource();
    src.buffer = this.noise.white;
    src.playbackRate.value = 0.94 + Math.random() * 0.14;

    const bp = this.ctx.createBiquadFilter();
    bp.type = 'bandpass';
    const center = 3300 + Math.random() * 900;
    safeSetValue(bp.frequency, center * 0.85, now, 1000, 9000);
    safeExpRamp(bp.frequency, center * 1.18, now + 0.06, 1000, 9000);
    safeExpRamp(bp.frequency, center * 0.72, now + 0.30, 800, 9000);
    bp.Q.value = 1.05;

    const g = this.ctx.createGain();
    safeSetValue(g.gain, 0.0001, now, 0.0001, 1);
    safeLinearRamp(g.gain, 0.16, now + 0.025, 0, 0.5);
    safeLinearRamp(g.gain, 0.125, now + 0.16, 0, 0.5);
    safeExpRamp(g.gain, 0.0004, now + 0.32, 0.0001, 0.5);

    src.connect(bp);
    bp.connect(g);
    g.connect(this.output);
    src.start(now);
    scheduleStop(src, now + 0.34, [bp, g]);
  }

  /** Pneumatic impact wrench torque zip + solid seating thud. */
  playPartInstall(): void {
    if (this.disposed) return;
    const now = this.ctx.currentTime;

    // 4 rapid tightening impact pulses rising slightly in pitch as bolt torques down
    const clicks = 4;
    for (let i = 0; i < clicks; i++) {
      const t = now + i * 0.036;
      const osc = this.ctx.createOscillator();
      const bp = this.ctx.createBiquadFilter();
      const g = this.ctx.createGain();

      osc.type = 'sawtooth';
      const f = 380 + i * 55;
      safeSetValue(osc.frequency, f, t, 80, 2000);
      safeExpRamp(osc.frequency, f * 1.35, t + 0.026, 80, 2200);

      bp.type = 'bandpass';
      bp.frequency.value = 1400 + i * 210;
      bp.Q.value = 2.4;

      safeSetValue(g.gain, 0.0001, t, 0.0001, 1);
      safeLinearRamp(g.gain, 0.15, t + 0.004, 0, 0.5);
      safeExpRamp(g.gain, 0.0005, t + 0.03, 0.0001, 0.5);

      osc.connect(bp);
      bp.connect(g);
      g.connect(this.output);
      osc.start(t);
      scheduleStop(osc, t + 0.036, [bp, g]);
    }

    // Solid part seated thump
    const thudTime = now + clicks * 0.036 + 0.01;
    const thud = this.ctx.createOscillator();
    const tg = this.ctx.createGain();
    thud.type = 'triangle';
    safeSetValue(thud.frequency, 155, thudTime, 40, 600);
    safeExpRamp(thud.frequency, 58, thudTime + 0.065, 30, 600);
    safeSetValue(tg.gain, 0.0001, thudTime, 0.0001, 1);
    safeLinearRamp(tg.gain, 0.17, thudTime + 0.004, 0, 0.5);
    safeExpRamp(tg.gain, 0.0005, thudTime + 0.075, 0.0001, 0.5);
    thud.connect(tg);
    tg.connect(this.output);
    thud.start(thudTime);
    scheduleStop(thud, thudTime + 0.085, [tg]);
  }

  /** Reverse socket ratchet unbolt + hollow release clink. */
  playPartRemove(): void {
    if (this.disposed) return;
    const now = this.ctx.currentTime;

    const clicks = 3;
    for (let i = 0; i < clicks; i++) {
      const t = now + i * 0.038;
      const osc = this.ctx.createOscillator();
      const bp = this.ctx.createBiquadFilter();
      const g = this.ctx.createGain();

      osc.type = 'sawtooth';
      const f = 540 - i * 65;
      safeSetValue(osc.frequency, f, t, 80, 2000);
      safeExpRamp(osc.frequency, f * 0.78, t + 0.028, 80, 2000);

      bp.type = 'bandpass';
      bp.frequency.value = 1750 - i * 180;
      bp.Q.value = 2.6;

      safeSetValue(g.gain, 0.0001, t, 0.0001, 1);
      safeLinearRamp(g.gain, 0.125, t + 0.003, 0, 0.5);
      safeExpRamp(g.gain, 0.0005, t + 0.032, 0.0001, 0.5);

      osc.connect(bp);
      bp.connect(g);
      g.connect(this.output);
      osc.start(t);
      scheduleStop(osc, t + 0.038, [bp, g]);
    }

    // Light metallic unbolt clink
    const clinkTime = now + 0.12;
    const clink = this.ctx.createOscillator();
    const cg = this.ctx.createGain();
    clink.type = 'sine';
    safeSetValue(clink.frequency, 1420, clinkTime, 400, 4000);
    safeExpRamp(clink.frequency, 960, clinkTime + 0.06, 300, 4000);
    safeSetValue(cg.gain, 0.0001, clinkTime, 0.0001, 0.5);
    safeLinearRamp(cg.gain, 0.075, clinkTime + 0.003, 0, 0.4);
    safeExpRamp(cg.gain, 0.0004, clinkTime + 0.07, 0.0001, 0.4);
    clink.connect(cg);
    cg.connect(this.output);
    clink.start(clinkTime);
    scheduleStop(clink, clinkTime + 0.078, [cg]);
  }

  /** Multi-wrench mechanical stock reset sweep + compressed air puff. */
  playStockReset(): void {
    if (this.disposed) return;
    const now = this.ctx.currentTime;

    for (let i = 0; i < 6; i++) {
      const t = now + i * 0.044;
      const pitch = 1100 + i * 185;
      this.playRelayMicroClick(t, 0.095 * (0.75 + i * 0.05), pitch);
    }

    // Air line release puff
    const airStart = now + 0.25;
    const hiss = this.ctx.createBufferSource();
    hiss.buffer = this.noise.white;
    const bp = this.ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = 3400;
    bp.Q.value = 1.4;
    const g = this.ctx.createGain();
    safeSetValue(g.gain, 0.0001, airStart, 0.0001, 1);
    safeLinearRamp(g.gain, 0.11, airStart + 0.015, 0, 0.5);
    safeExpRamp(g.gain, 0.0004, airStart + 0.2, 0.0001, 0.5);
    hiss.connect(bp);
    bp.connect(g);
    g.connect(this.output);
    hiss.start(airStart);
    scheduleStop(hiss, airStart + 0.22, [bp, g]);
  }

  /** Crisp two-stage automotive dashboard relay toggle click. */
  playLightSwitch(): void {
    if (this.disposed) return;
    const now = this.ctx.currentTime;
    this.playRelayMicroClick(now, 0.12, 2450);
    this.playRelayMicroClick(now + 0.019, 0.075, 1620);
  }

  /** Subtle airy bandpass swoosh for camera preset / bay transitions. */
  playCameraSwoosh(): void {
    if (this.disposed) return;
    const now = this.ctx.currentTime;

    const src = this.ctx.createBufferSource();
    src.buffer = this.noise.pink;

    const bp = this.ctx.createBiquadFilter();
    bp.type = 'bandpass';
    safeSetValue(bp.frequency, 240, now, 100, 4000);
    safeExpRamp(bp.frequency, 980, now + 0.11, 120, 4000);
    safeExpRamp(bp.frequency, 310, now + 0.25, 100, 4000);
    bp.Q.value = 1.6;

    const g = this.ctx.createGain();
    safeSetValue(g.gain, 0.0001, now, 0.0001, 1);
    safeLinearRamp(g.gain, 0.085, now + 0.065, 0, 0.4);
    safeExpRamp(g.gain, 0.0004, now + 0.26, 0.0001, 0.4);

    src.connect(bp);
    bp.connect(g);
    g.connect(this.output);
    src.start(now);
    scheduleStop(src, now + 0.28, [bp, g]);
  }

  /**
   * Subtle garage bay door rumble + optional brief ignition rev preview callback
   * when choosing a car in the showroom selector.
   */
  playCarSelect(onEnginePreview?: () => void): void {
    if (this.disposed) return;
    const now = this.ctx.currentTime;

    // Low rolling turntable / bay door rumble
    const rumble = this.ctx.createBufferSource();
    rumble.buffer = this.noise.brown;
    const lp = this.ctx.createBiquadFilter();
    lp.type = 'lowpass';
    safeSetValue(lp.frequency, 150, now, 50, 500);
    safeExpRamp(lp.frequency, 95, now + 0.34, 40, 500);

    const g = this.ctx.createGain();
    safeSetValue(g.gain, 0.0001, now, 0.0001, 1);
    safeLinearRamp(g.gain, 0.14, now + 0.055, 0, 0.5);
    safeExpRamp(g.gain, 0.0005, now + 0.38, 0.0001, 0.5);

    rumble.connect(lp);
    lp.connect(g);
    g.connect(this.output);
    rumble.start(now);
    scheduleStop(rumble, now + 0.4, [lp, g]);

    // Crisp bay latch
    this.playRelayMicroClick(now + 0.02, 0.06, 1320);

    if (onEnginePreview) {
      onEnginePreview();
    }
  }

  /** Ultra-clean, subtle tactile mechanical UI micro-click. */
  playUiClick(): void {
    if (this.disposed) return;
    const now = this.ctx.currentTime;
    if (now - this.lastClickTime < 0.028) return;
    this.lastClickTime = now;
    this.playRelayMicroClick(now, 0.065, 2900);
  }

  /** Stops all continuous garage ambience nodes and disconnects. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.liftMoving = false;
    const now = this.ctx.currentTime;
    const sources: AudioScheduledSourceNode[] = [
      this.roomNoise,
      this.hvacNoise,
      this.liftOsc1,
      this.liftOsc2,
    ];
    for (const src of sources) {
      try {
        src.stop(now + 0.01);
        src.disconnect();
      } catch {
        // Already stopped.
      }
    }
    try {
      this.output.disconnect();
    } catch {
      // Already disconnected.
    }
  }

  // ------------------------------------------------------------------ micro impulse helper

  private playRelayMicroClick(start: number, volume: number, centerHz: number): void {
    const osc = this.ctx.createOscillator();
    const hp = this.ctx.createBiquadFilter();
    const g = this.ctx.createGain();

    osc.type = 'triangle';
    safeSetValue(osc.frequency, centerHz, start, 200, 8000);
    safeExpRamp(osc.frequency, centerHz * 0.42, start + 0.016, 150, 8000);

    hp.type = 'highpass';
    hp.frequency.value = Math.max(300, centerHz * 0.35);

    safeSetValue(g.gain, 0.0001, start, 0.0001, 1);
    safeLinearRamp(g.gain, volume, start + 0.002, 0, 0.4);
    safeExpRamp(g.gain, 0.0003, start + 0.02, 0.0001, 0.4);

    osc.connect(hp);
    hp.connect(g);
    g.connect(this.output);
    osc.start(start);
    scheduleStop(osc, start + 0.025, [hp, g]);
  }
}
