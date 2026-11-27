import { clampFinite } from './dsp';
import type { EngineAcousticProfile, ShiftDirection } from './types';

export const ENGINE_WORKLET_NAME = 'blend-garage-engine-processor';

export interface EngineWorkletProfilePayload {
  id: string;
  idleRpm: number;
  redlineRpm: number;
  cylinders: number;
  firingAnglesDeg: number[];
  cylinderBanks: number[];
  pulseSharpness: number;
  pulseDecayMs: number;
  pulseTurbulence: number;
  cycleJitter: number;
  headerDelayLMs: number;
  headerDelayRMs: number;
  collectorCrossFeed: number;
  tailpipeDelayMs: number;
  pipeFeedback: number;
  pipeDamping: number;
  mufflerResonanceHz: number;
  mufflerBody: number;
  intakeResonanceHz: number;
  crankcaseWhir: number;
  saturationDrive: number;
  saturationBias: number;
  filterMinHz: number;
  filterMaxHz: number;
  formantMinHz: number;
  formantMaxHz: number;
  hasTurbo: boolean;
  turboWhineGain: number;
  turboPitchMin: number;
  turboPitchMax: number;
  crackleIntensity: number;
  shiftPopIntensity: number;
  starterCrankHz: number;
  outputTrim: number;
  electricWhine: number;
}

export interface EngineWorkletFramePayload {
  active: boolean;
  rpm: number;
  idleRpm: number;
  redlineRpm: number;
  throttle: number;
  turboBoost: number;
  speedMps: number;
  engineHealth: number;
  cameraBrightness: number;
  cameraIntakeBoost: number;
  cameraLevel: number;
}

/** Converts an `EngineAcousticProfile` into a flat, clone-safe worklet message payload. */
export function serializeWorkletProfile(profile: EngineAcousticProfile): EngineWorkletProfilePayload {
  const phys = profile.physical;
  return {
    id: profile.id,
    idleRpm: profile.idleRpm,
    redlineRpm: profile.redlineRpm,
    cylinders: phys.cylinders,
    firingAnglesDeg: [...phys.firingAnglesDeg],
    cylinderBanks: [...phys.cylinderBanks],
    pulseSharpness: phys.pulseSharpness,
    pulseDecayMs: phys.pulseDecayMs,
    pulseTurbulence: phys.pulseTurbulence,
    cycleJitter: phys.cycleJitter,
    headerDelayLMs: phys.headerDelayLMs,
    headerDelayRMs: phys.headerDelayRMs,
    collectorCrossFeed: phys.collectorCrossFeed,
    tailpipeDelayMs: phys.tailpipeDelayMs,
    pipeFeedback: phys.pipeFeedback,
    pipeDamping: phys.pipeDamping,
    mufflerResonanceHz: phys.mufflerResonanceHz,
    mufflerBody: phys.mufflerBody,
    intakeResonanceHz: phys.intakeResonanceHz,
    crankcaseWhir: phys.crankcaseWhir,
    saturationDrive: profile.saturationDrive,
    saturationBias: profile.saturationBias,
    filterMinHz: profile.filterMinHz,
    filterMaxHz: profile.filterMaxHz,
    formantMinHz: profile.formantMinHz,
    formantMaxHz: profile.formantMaxHz,
    hasTurbo: profile.hasTurbo,
    turboWhineGain: profile.turboWhineGain,
    turboPitchMin: profile.turboPitchRange[0],
    turboPitchMax: profile.turboPitchRange[1],
    crackleIntensity: profile.crackleIntensity,
    shiftPopIntensity: profile.shiftPopIntensity,
    starterCrankHz: profile.starterCrankHz,
    outputTrim: profile.outputTrim,
    electricWhine: clampFinite(profile.electricWhine ?? 0, 0, 1, 0),
  };
}

/**
 * Self-contained 48 kHz physical 4-stroke crankshaft combustion + dual-bank exhaust waveguide
 * `AudioWorkletProcessor` source code. Loaded via inline Blob URL so it works identically on
 * Vite dev servers and static GitHub Pages without external file paths.
 */
export const ENGINE_WORKLET_CODE = `
class PhysicalEngineKernel {
  constructor(sr) {
    this.sr = Math.max(8000, Math.min(192000, Number.isFinite(sr) ? sr : 48000));
    this.rng = 0x13579bdf;

    // Delay buffers (2048 samples = 42.6 ms at 48 kHz)
    this.D = 2048;
    this.MASK = 2047;
    this.hdrL = new Float32Array(this.D);
    this.hdrR = new Float32Array(this.D);
    this.pipeL = new Float32Array(this.D);
    this.pipeR = new Float32Array(this.D);
    this.wIdx = 0;

    // One-pole lowpass states inside waveguides
    this.hdrLpL = 0;
    this.hdrLpR = 0;
    this.pipeLpL = 0;
    this.pipeLpR = 0;

    // Active smooth combustion pulse slots (8 per bank, zero allocations)
    this.MAX_P = 8;
    this.pAct = new Uint8Array(16);
    this.pBank = new Uint8Array(16);
    this.pAge = new Float32Array(16);
    this.pAtk = new Float32Array(16);
    this.pDec = new Float32Array(16);
    this.pAmp = new Float32Array(16);
    this.pTurb = new Float32Array(16);
    this.pScav = new Float32Array(16);
    this.pCursor = 0;

    // Overrun exhaust pop impulse slots (injected directly into tailpipe waveguide)
    this.popAge = new Float32Array(4);
    this.popDec = new Float32Array(4);
    this.popAmp = new Float32Array(4);
    this.popBank = new Uint8Array(4);
    this.popAct = new Uint8Array(4);
    this.popCursor = 0;

    // Muffler Helmholtz SVF + Exhaust Lowpass + Intake Plenum SVF + Turbo SVF states
    this.mufLowL = 0; this.mufBandL = 0;
    this.mufLowR = 0; this.mufBandR = 0;
    this.lp1L = 0; this.lp2L = 0;
    this.lp1R = 0; this.lp2R = 0;
    this.inLow = 0; this.inBand = 0;
    this.pink0 = 0; this.pink1 = 0; this.pink2 = 0;
    this.turbLow = 0; this.turbBand = 0;
    this.dcPrevInL = 0; this.dcPrevOutL = 0;
    this.dcPrevInR = 0; this.dcPrevOutR = 0;

    // Crankshaft, turbo, whir & EV phase accumulators
    this.crankDeg = 0;
    this.turboPhase = 0;
    this.whirPhase = 0;
    this.evPhase1 = 0;
    this.evPhase2 = 0;
    this.evPhase3 = 0;
    this.starterPhase = 0;

    // Per-cylinder subtle static manufacturing variation
    this.cylVar = new Float32Array(16);
    for (let i = 0; i < 16; i++) {
      this.cylVar[i] = 0.93 + this.rand() * 0.14;
    }

    // Live control state (smoothed at sample rate)
    this.active = false;
    this.activeEnv = 0;
    this.tRpm = 900; this.rpm = 900;
    this.idleRpm = 900;
    this.redlineRpm = 8500;
    this.tThrottle = 0; this.throttle = 0;
    this.tBoost = 0; this.boost = 0;
    this.tSpeed = 0; this.speed = 0;
    this.health = 1;
    this.camBright = 1;
    this.camIntake = 1;
    this.camLevel = 1;

    // Transients (ignition crank, shift ignition cut, downshift blip, rev preview, crackles)
    this.cutSamples = 0;
    this.blipSamples = 0;
    this.blipRpm = 0;
    this.crankSamples = 0;
    this.crankTotal = 0;
    this.flareSamples = 0;
    this.flareTotal = 0;
    this.flarePeakRpm = 3600;
    this.previewEnv = 0;
    this.previewSamples = 0;
    this.previewTotal = 0;
    this.previewPeakRpm = 4800;
    this.crackleCountdown = 0.15 * this.sr;
    this.limiterPhase = 0;
    this.prevRpmSample = 900;

    // Default V10 profile
    this.isSingleBank = false;
    this.p = {
      idleRpm: 900, redlineRpm: 8600, cylinders: 10,
      firingAnglesDeg: [0, 54, 144, 198, 288, 342, 432, 486, 576, 630],
      cylinderBanks: [0, 1, 0, 1, 0, 1, 0, 1, 0, 1],
      pulseSharpness: 1.32, pulseDecayMs: 3.7, pulseTurbulence: 0.24, cycleJitter: 0.068,
      headerDelayLMs: 0.96, headerDelayRMs: 1.07, collectorCrossFeed: 0.34,
      tailpipeDelayMs: 3.4, pipeFeedback: 0.56, pipeDamping: 0.39,
      mufflerResonanceHz: 182, mufflerBody: 0.46, intakeResonanceHz: 1340, crankcaseWhir: 0.2,
      saturationDrive: 4.1, saturationBias: 0.15, filterMinHz: 400, filterMaxHz: 5800,
      formantMinHz: 780, formantMaxHz: 2550, hasTurbo: false, turboWhineGain: 0,
      turboPitchMin: 2000, turboPitchMax: 5600, crackleIntensity: 0.85, shiftPopIntensity: 0.92,
      starterCrankHz: 108, outputTrim: 0.98, electricWhine: 0,
    };
  }

  rand() {
    let x = this.rng | 0;
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    this.rng = x >>> 0;
    return this.rng / 4294967296;
  }

  setProfile(p) {
    if (!p || !Array.isArray(p.firingAnglesDeg) || p.firingAnglesDeg.length === 0) return;
    this.p = p;
    this.idleRpm = p.idleRpm || 900;
    this.redlineRpm = p.redlineRpm || 8500;
    this.isSingleBank = Array.isArray(p.cylinderBanks) && p.cylinderBanks.length > 0 && p.cylinderBanks.every((b) => (b & 1) === 0);
    for (let i = 0; i < 16; i++) {
      this.cylVar[i] = 0.93 + this.rand() * 0.14;
    }
  }

  setFrame(f) {
    if (!f) return;
    this.active = Boolean(f.active);
    if (Number.isFinite(f.idleRpm)) this.idleRpm = Math.max(400, Math.min(2000, f.idleRpm));
    if (Number.isFinite(f.redlineRpm)) this.redlineRpm = Math.max(this.idleRpm + 1500, Math.min(15000, f.redlineRpm));
    if (Number.isFinite(f.rpm)) this.tRpm = Math.max(0, Math.min(this.redlineRpm * 1.12, f.rpm));
    if (Number.isFinite(f.throttle)) this.tThrottle = Math.max(0, Math.min(1, f.throttle));
    if (Number.isFinite(f.turboBoost)) this.tBoost = Math.max(0, Math.min(1, f.turboBoost));
    if (Number.isFinite(f.speedMps)) this.tSpeed = Math.max(0, Math.min(140, Math.abs(f.speedMps)));
    if (Number.isFinite(f.engineHealth)) this.health = Math.max(0, Math.min(1, f.engineHealth));
    if (Number.isFinite(f.cameraBrightness)) this.camBright = Math.max(0.5, Math.min(1.6, f.cameraBrightness));
    if (Number.isFinite(f.cameraIntakeBoost)) this.camIntake = Math.max(0.4, Math.min(1.8, f.cameraIntakeBoost));
    if (Number.isFinite(f.cameraLevel)) this.camLevel = Math.max(0.4, Math.min(1.5, f.cameraLevel));
  }

  triggerIgnition() {
    this.crankTotal = Math.floor(this.sr * 0.34);
    this.crankSamples = this.crankTotal;
    this.flareTotal = Math.floor(this.sr * 0.56);
    this.flareSamples = this.flareTotal;
    this.flarePeakRpm = this.idleRpm + (this.redlineRpm - this.idleRpm) * 0.40;
  }

  triggerShift(direction, rpm) {
    const safeRpm = Number.isFinite(rpm) ? rpm : this.rpm;
    const norm = Math.max(0, Math.min(1, (safeRpm - this.idleRpm) / Math.max(1, this.redlineRpm - this.idleRpm)));
    if (direction === 'up') {
      this.cutSamples = Math.floor(this.sr * 0.068);
      if (this.p.shiftPopIntensity > 0.1 && this.p.electricWhine < 0.5) {
        this.spawnWaveguidePop(0.45 + norm * 0.55 * this.p.shiftPopIntensity, 0);
        if (norm > 0.55) this.spawnWaveguidePop(0.32 * this.p.shiftPopIntensity, 1);
      }
    } else {
      this.blipSamples = Math.floor(this.sr * 0.145);
      this.blipRpm = 950 + norm * 1450;
      if (this.p.crackleIntensity > 0.2 && this.p.electricWhine < 0.5) {
        this.spawnWaveguidePop(0.38 * this.p.crackleIntensity, this.rand() > 0.5 ? 1 : 0);
      }
    }
  }

  triggerRevPreview(profile) {
    if (profile) this.setProfile(profile);
    this.previewTotal = Math.floor(this.sr * 1.15);
    this.previewSamples = this.previewTotal;
    this.previewPeakRpm = this.idleRpm + (this.redlineRpm - this.idleRpm) * 0.64;
  }

  spawnPulse(bank, amp, atkMs, decMs, turb, scav) {
    const idx = this.pCursor;
    this.pCursor = (this.pCursor + 1) & 15;
    this.pAct[idx] = 1;
    this.pBank[idx] = bank & 1;
    this.pAge[idx] = 0;
    this.pAtk[idx] = Math.max(4, atkMs * 0.001 * this.sr);
    this.pDec[idx] = Math.max(16, decMs * 0.001 * this.sr);
    this.pAmp[idx] = amp;
    this.pTurb[idx] = turb;
    this.pScav[idx] = scav;
  }

  spawnWaveguidePop(strength, bank) {
    const idx = this.popCursor;
    this.popCursor = (this.popCursor + 1) & 3;
    this.popAct[idx] = 1;
    this.popBank[idx] = bank & 1;
    this.popAge[idx] = 0;
    this.popDec[idx] = Math.max(48, (0.012 + this.rand() * 0.018) * this.sr);
    this.popAmp[idx] = Math.max(0.15, Math.min(1.4, strength)) * (0.75 + this.rand() * 0.45);
  }

  readDelay(buf, delaySamples) {
    const d = Math.max(2, Math.min(this.D - 4, delaySamples));
    const r = this.wIdx - d;
    const i0 = Math.floor(r) & this.MASK;
    const i1 = (i0 + 1) & this.MASK;
    const frac = r - Math.floor(r);
    return buf[i0] + (buf[i1] - buf[i0]) * frac;
  }

  processBlock(outL, outR) {
    const n = outL.length;
    const p = this.p;
    const sr = this.sr;
    const angles = p.firingAnglesDeg;
    const banks = p.cylinderBanks;
    const cylCount = angles.length;
    const evBlend = p.electricWhine || 0;
    const combWeight = Math.max(0, 1 - evBlend * 0.94);

    // Precompute smoothed delay lengths in samples
    const hdrDelayLSamp = p.headerDelayLMs * 0.001 * sr;
    const hdrDelayRSamp = p.headerDelayRMs * 0.001 * sr;
    const pipeDelayLSamp = p.tailpipeDelayMs * 0.001 * sr;
    const pipeDelayRSamp = p.tailpipeDelayMs * 1.035 * 0.001 * sr;
    const fb = Math.max(0.1, Math.min(0.64, p.pipeFeedback));
    const xFeed = Math.max(0, Math.min(0.5, p.collectorCrossFeed));
    const smoothK = 1 - Math.exp(-1 / (0.016 * sr));
    const envSmoothK = 1 - Math.exp(-1 / (0.042 * sr));

    for (let s = 0; s < n; s++) {
      // Smooth master active envelope & preview envelope
      const targetAct = this.active ? 1 : 0;
      this.activeEnv += (targetAct - this.activeEnv) * envSmoothK;

      let previewRpm = 0;
      let previewThr = 0;
      let previewGate = 0;
      if (this.previewSamples > 0) {
        const elapsed = 1 - this.previewSamples / Math.max(1, this.previewTotal);
        this.previewSamples -= 1;
        if (elapsed < 0.28) {
          const k = elapsed / 0.28;
          const ease = k * k * (3 - 2 * k);
          previewRpm = this.idleRpm + (this.previewPeakRpm - this.idleRpm) * ease;
          previewThr = 0.88;
          previewGate = Math.min(1, elapsed / 0.04);
        } else if (elapsed < 0.65) {
          const k = (elapsed - 0.28) / 0.37;
          previewRpm = this.previewPeakRpm - (this.previewPeakRpm - this.idleRpm * 1.15) * Math.pow(k, 0.72);
          previewThr = 0.04;
          previewGate = 1;
        } else {
          const k = (elapsed - 0.65) / 0.35;
          previewRpm = this.idleRpm * 1.15 - (this.idleRpm * 0.15) * k;
          previewThr = 0.02;
          previewGate = Math.max(0, 1 - k * k);
        }
        if (elapsed > 0.30 && elapsed < 0.302 && p.crackleIntensity > 0.3 && evBlend < 0.5) {
          this.spawnWaveguidePop(0.55 * p.crackleIntensity, 0);
        }
        if (elapsed > 0.42 && elapsed < 0.422 && p.crackleIntensity > 0.4 && evBlend < 0.5) {
          this.spawnWaveguidePop(0.42 * p.crackleIntensity, 1);
        }
      }
      this.previewEnv += (previewGate - this.previewEnv) * envSmoothK;

      const totalGate = Math.max(this.activeEnv, this.previewEnv * 0.72);
      if (totalGate < 0.0002) {
        outL[s] = 0;
        outR[s] = 0;
        continue;
      }

      // Smooth control inputs
      const targetRpm = previewGate > 0.05 && !this.active ? previewRpm : this.tRpm;
      const targetThr = previewGate > 0.05 && !this.active ? previewThr : this.tThrottle;
      this.rpm += (targetRpm - this.rpm) * smoothK;
      this.throttle += (targetThr - this.throttle) * smoothK;
      this.boost += (this.tBoost - this.boost) * smoothK;
      this.speed += (this.tSpeed - this.speed) * smoothK;

      // Apply cold-start ignition flare & downshift rev-match blip
      let effRpm = Math.max(this.idleRpm * 0.74, this.rpm);
      let effThr = this.throttle;
      if (this.blipSamples > 0) {
        const bk = this.blipSamples / Math.max(1, 0.145 * sr);
        effRpm += this.blipRpm * bk;
        effThr = Math.max(effThr, 0.82 * bk);
        this.blipSamples -= 1;
      }
      let starterSig = 0;
      if (this.crankSamples > 0) {
        const ck = 1 - this.crankSamples / Math.max(1, this.crankTotal);
        this.crankSamples -= 1;
        if (evBlend < 0.5) {
          // Authentic 3-compression starter motor crank pulses
          const compPulse = Math.max(0, Math.sin(ck * Math.PI * 6));
          this.starterPhase += ((p.starterCrankHz * (0.9 + compPulse * 0.3)) / sr) * Math.PI * 2;
          if (this.starterPhase > Math.PI * 2) this.starterPhase -= Math.PI * 2;
          starterSig = (Math.sin(this.starterPhase) * 0.5 + Math.sin(this.starterPhase * 2.02) * 0.35) * compPulse * 0.22;
          effRpm = this.idleRpm * (0.42 + ck * 0.58);
        }
      } else if (this.flareSamples > 0) {
        const fk = 1 - this.flareSamples / Math.max(1, this.flareTotal);
        this.flareSamples -= 1;
        const flareEnv = fk < 0.25 ? fk / 0.25 : Math.pow(1 - (fk - 0.25) / 0.75, 1.3);
        effRpm = Math.max(effRpm, this.idleRpm + (this.flarePeakRpm - this.idleRpm) * flareEnv);
        effThr = Math.max(effThr, flareEnv * 0.65);
      }

      const rpmSpan = Math.max(1, this.redlineRpm - this.idleRpm);
      const rpmNorm = Math.max(0, Math.min(1.08, (effRpm - this.idleRpm) / rpmSpan));
      const idleProx = Math.max(0, Math.min(1, 1 - rpmNorm * 3.6));
      const dmg = this.health < 0.65 ? (0.65 - this.health) / 0.65 : 0;

      // Internal white & warm pink noise
      const wn = this.rand() * 2 - 1;
      this.pink0 = 0.996 * this.pink0 + wn * 0.055;
      this.pink1 = 0.965 * this.pink1 + wn * 0.145;
      this.pink2 = 0.780 * this.pink2 + wn * 0.320;
      const pn = (this.pink0 + this.pink1 + this.pink2) * 0.42;

      // Ignition cut / rev limiter spark gating
      let sparkAllowed = true;
      if (this.cutSamples > 0) {
        this.cutSamples -= 1;
        sparkAllowed = false;
      } else if (rpmNorm >= 0.985 && effThr > 0.42 && evBlend < 0.5) {
        this.limiterPhase += 19.0 / sr;
        if (this.limiterPhase >= 1) this.limiterPhase -= 1;
        if (this.limiterPhase < 0.42) {
          sparkAllowed = false;
          if (this.limiterPhase < 0.004) {
            this.spawnWaveguidePop(0.55 * p.shiftPopIntensity, this.rand() > 0.5 ? 1 : 0);
          }
        }
      }

      // Compression-stroke crank velocity wobble at low idle (gives visceral organic idle lope!)
      const crankRad = this.crankDeg * 0.017453292519943295;
      const idleWobble = 1 + (idleProx * (0.045 + p.cycleJitter * 0.28) + dmg * 0.08) * Math.sin(crankRad * (cylCount * 0.5));
      const prevDeg = this.crankDeg;
      const degStep = ((effRpm * 6.0) / sr) * Math.max(0.7, Math.min(1.3, idleWobble));
      let nextDeg = prevDeg + degStep;
      const wrapped = nextDeg >= 720;
      if (wrapped) nextDeg -= 720;
      this.crankDeg = nextDeg;

      // Check cylinder firings across [prevDeg, nextDeg)
      if (combWeight > 0.02) {
        for (let c = 0; c < cylCount; c++) {
          const ang = angles[c];
          const fired = wrapped ? (ang >= prevDeg || ang < nextDeg) : (ang >= prevDeg && ang < nextDeg);
          if (!fired) continue;

          // Engine health misfires (skip spark occasionally when badly damaged)
          if (dmg > 0.08 && this.rand() < dmg * 0.34) {
            if (this.rand() < 0.35) this.spawnWaveguidePop(0.45 * dmg, banks[c]);
            continue;
          }

          const jitter = 1 + (this.rand() * 2 - 1) * (p.cycleJitter + dmg * 0.12);
          const bank = banks[c] & 1;

          if (!sparkAllowed) {
            // Pumping air compression without combustion during ignition cut
            this.spawnPulse(bank, 0.14 * this.cylVar[c], 0.9, 2.8, 0.12, 0.08);
            continue;
          }

          // On-throttle pressurized roar vs off-throttle hollow overrun burble
          const onThrottleAmp = (0.34 + effThr * 0.88 + rpmNorm * 0.28) * this.cylVar[c] * jitter;
          const overrunScale = effThr < 0.08 ? 0.52 : 1.0;
          const amp = onThrottleAmp * overrunScale;

          // Shorter, sharper attack & tighter decay as RPM and load climb
          const speedTighten = 1 / (1 + rpmNorm * 2.4);
          const atkMs = (1.15 / Math.max(0.5, p.pulseSharpness)) * (0.48 + 0.52 * speedTighten) * (1.18 - effThr * 0.45);
          const decMs = p.pulseDecayMs * (0.28 + 0.72 * speedTighten) * (0.85 + effThr * 0.25);
          const turb = p.pulseTurbulence * (0.55 + effThr * 0.85);
          const scav = 0.24 + (1 - effThr) * 0.14;

          this.spawnPulse(bank, amp, atkMs, decMs, turb, scav);
        }
      }

      // Stochastic off-throttle exhaust overrun crackles fired directly into exhaust waveguide
      if (combWeight > 0.5 && p.crackleIntensity > 0.05 && effThr < 0.09 && rpmNorm > 0.22 && effRpm <= this.prevRpmSample + 3.5) {
        this.crackleCountdown -= 1;
        if (this.crackleCountdown <= 0) {
          const str = p.crackleIntensity * (0.30 + rpmNorm * 0.72);
          this.spawnWaveguidePop(str, this.rand() > 0.5 ? 1 : 0);
          const minSec = 0.045 + (1 - rpmNorm) * 0.12;
          const maxSec = 0.16 + (1 - rpmNorm) * 0.26;
          this.crackleCountdown = (minSec + this.rand() * (maxSec - minSec)) * sr;
        }
      } else {
        this.crackleCountdown = Math.min(this.crackleCountdown, 0.09 * sr);
      }
      this.prevRpmSample = effRpm;

      // Evaluate active combustion pulse bank (L & R)
      let cylL = 0;
      let cylR = 0;
      for (let i = 0; i < 16; i++) {
        if (!this.pAct[i]) continue;
        const age = this.pAge[i];
        const atk = this.pAtk[i];
        const dec = this.pDec[i];
        let val = 0;
        if (age < atk) {
          // Smooth band-limited raised-cosine combustion pressure front
          const u = age / atk;
          val = 0.5 - 0.5 * Math.cos(u * Math.PI);
        } else {
          const d = (age - atk) / dec;
          if (d > 6.5) {
            this.pAct[i] = 0;
            continue;
          }
          // Exponential blowdown + realistic negative scavenging rarefaction trough
          const env = Math.exp(-d);
          val = env * (1 - this.pScav[i] * Math.sin(Math.min(Math.PI, d * 1.45)));
        }
        // Exhaust-valve supersonic gas turbulence rides on the combustion pressure peak
        const turbSig = (1 + pn * this.pTurb[i] * 2.2);
        const sample = val * this.pAmp[i] * turbSig;
        if (this.pBank[i] === 0) cylL += sample;
        else cylR += sample;
        this.pAge[i] = age + 1;
      }

      // Normalize slightly for higher cylinder counts so V12 and V8 share balanced headroom
      const cylNorm = 1.65 / Math.sqrt(Math.max(4, cylCount));
      cylL *= cylNorm;
      cylR *= cylNorm;

      // Evaluate overrun / shift exhaust waveguide backfire pops
      let popL = 0;
      let popR = 0;
      for (let i = 0; i < 4; i++) {
        if (!this.popAct[i]) continue;
        const d = this.popAge[i] / this.popDec[i];
        if (d > 6.0) {
          this.popAct[i] = 0;
          continue;
        }
        const env = Math.exp(-d * 1.35);
        const popVal = (env * (0.45 + wn * 0.95)) * this.popAmp[i] * 1.15;
        if (this.popBank[i] === 0) popL += popVal;
        else popR += popVal;
        this.popAge[i] += 1;
      }

      // === DUAL-BANK PHYSICAL EXHAUST WAVEGUIDE ===
      // Reflection damping opens up with throttle heat & RPM for crisp upper rasp
      const dampAlpha = Math.max(0.12, Math.min(0.88, (1 - p.pipeDamping) * (0.62 + effThr * 0.42 + rpmNorm * 0.22)));

      // Stage 1: Left & Right primary exhaust headers
      const delHdrL = this.readDelay(this.hdrL, hdrDelayLSamp);
      const delHdrR = this.readDelay(this.hdrR, hdrDelayRSamp);
      this.hdrLpL += (delHdrL - this.hdrLpL) * dampAlpha;
      this.hdrLpR += (delHdrR - this.hdrLpR) * dampAlpha;
      const hdrOutL = cylL - this.hdrLpL * (fb * 0.58);
      const hdrOutR = cylR - this.hdrLpR * (fb * 0.58);
      this.hdrL[this.wIdx] = Math.tanh(hdrOutL * 0.85);
      this.hdrR[this.wIdx] = Math.tanh(hdrOutR * 0.85);

      // Collector / X-pipe junction (if single bank like I6, feed both pipes symmetrically)
      const isSingleBank = this.isSingleBank;
      const colL = isSingleBank
        ? hdrOutL * 0.72 + popL
        : hdrOutL * (1 - xFeed) + hdrOutR * xFeed + popL;
      const colR = isSingleBank
        ? hdrOutL * 0.72 + popR
        : hdrOutR * (1 - xFeed) + hdrOutL * xFeed + popR;

      // Stage 2: Main tailpipe waveguides (inverted open-end reflection -> tubular hollow roar!)
      const delPipeL = this.readDelay(this.pipeL, pipeDelayLSamp);
      const delPipeR = this.readDelay(this.pipeR, pipeDelayRSamp);
      this.pipeLpL += (delPipeL - this.pipeLpL) * dampAlpha;
      this.pipeLpR += (delPipeR - this.pipeLpR) * dampAlpha;
      const pipeOutL = colL - this.pipeLpL * fb;
      const pipeOutR = colR - this.pipeLpR * fb;
      this.pipeL[this.wIdx] = Math.tanh(pipeOutL * 0.85);
      this.pipeR[this.wIdx] = Math.tanh(pipeOutR * 0.85);

      this.wIdx = (this.wIdx + 1) & this.MASK;

      // === HELMHOLTZ MUFFLER CAVITY RESONANCE (chesty low-mid exhaust body) ===
      const mufF = Math.min(0.45, 2 * Math.sin(Math.PI * Math.min(sr * 0.2, p.mufflerResonanceHz * (0.9 + rpmNorm * 0.35)) / sr));
      const mufQ = 0.58;
      this.mufLowL += mufF * this.mufBandL;
      const mufHighL = pipeOutL - this.mufLowL - mufQ * this.mufBandL;
      this.mufBandL += mufF * mufHighL;

      this.mufLowR += mufF * this.mufBandR;
      const mufHighR = pipeOutR - this.mufLowR - mufQ * this.mufBandR;
      this.mufBandR += mufF * mufHighR;

      const bodyL = pipeOutL * 0.68 + this.mufBandL * (p.mufflerBody * 0.65) + this.mufLowL * (p.mufflerBody * 0.55);
      const bodyR = pipeOutR * 0.68 + this.mufBandR * (p.mufflerBody * 0.65) + this.mufLowR * (p.mufflerBody * 0.55);

      // === SOFT ASYMMETRIC TUBE / MUFFLER SATURATION ===
      const drive = (0.55 + effThr * 0.85 + rpmNorm * 0.35) * (p.saturationDrive * 0.32);
      const bias = p.saturationBias * 0.35;
      const normSat = Math.tanh(Math.max(0.5, drive));
      const satL = Math.tanh((bodyL + bias * bodyL * bodyL) * drive) / normSat;
      const satR = Math.tanh((bodyR + bias * bodyR * bodyR) * drive) / normSat;

      // === DYNAMIC RPM/THROTTLE-TRACKED 2-POLE EXHAUST LOWPASS ===
      const lpCutoff = Math.max(
        180,
        Math.min(sr * 0.38, (p.filterMinHz + (p.filterMaxHz - p.filterMinHz) * (Math.pow(rpmNorm, 0.85) * 0.64 + effThr * 0.40)) * this.camBright)
      );
      const lpA = Math.min(0.92, 1 - Math.exp((-2 * Math.PI * lpCutoff) / sr));
      this.lp1L += (satL - this.lp1L) * lpA;
      this.lp2L += (this.lp1L - this.lp2L) * lpA;
      this.lp1R += (satR - this.lp1R) * lpA;
      this.lp2R += (this.lp1R - this.lp2R) * lpA;

      // === OPEN-THROTTLE INTAKE PLENUM ROAR (throaty induction bark on throttle!) ===
      const intakeHz = Math.min(sr * 0.32, p.intakeResonanceHz * (0.55 + rpmNorm * 0.95));
      const inF = Math.min(0.45, 2 * Math.sin((Math.PI * intakeHz) / sr));
      const intakeExc = (pn * 0.85 + (cylL + cylR) * 0.35) * (0.10 + Math.pow(effThr, 1.15) * 0.90);
      this.inLow += inF * this.inBand;
      const inHigh = intakeExc - this.inLow - 0.52 * this.inBand;
      this.inBand += inF * inHigh;
      const intakeSig = this.inBand * (0.20 + rpmNorm * 0.34) * this.camIntake * combWeight;

      // === SUBTLE MECHANICAL VALVETRAIN / CAMSHAFT WHIR ===
      const whirHz = Math.min(sr * 0.3, 180 + effRpm * 0.24);
      this.whirPhase += (whirHz / sr) * Math.PI * 2;
      if (this.whirPhase > Math.PI * 2) this.whirPhase -= Math.PI * 2;
      const whirSig = Math.sin(this.whirPhase) * (0.5 + 0.5 * pn) * p.crankcaseWhir * (0.04 + rpmNorm * 0.10) * this.camIntake * combWeight;

      // === TURBOCHARGER COMPRESSOR SPOOL WHISTLE ===
      let turboSig = 0;
      if (p.hasTurbo && p.turboWhineGain > 0) {
        const effBoost = Math.max(this.boost, Math.max(0, (rpmNorm - 0.22) * effThr * 0.95));
        if (effBoost > 0.02) {
          const tHz = p.turboPitchMin + (p.turboPitchMax - p.turboPitchMin) * Math.pow(effBoost, 0.82);
          this.turboPhase += (Math.min(sr * 0.4, tHz) / sr) * Math.PI * 2;
          if (this.turboPhase > Math.PI * 2) this.turboPhase -= Math.PI * 2;
          const tF = Math.min(0.48, 2 * Math.sin((Math.PI * Math.min(sr * 0.38, tHz * 1.12)) / sr));
          this.turbLow += tF * this.turbBand;
          const tHigh = wn - this.turbLow - 0.26 * this.turbBand;
          this.turbBand += tF * tHigh;
          turboSig = (Math.sin(this.turboPhase) * 0.58 + this.turbBand * 0.42) * Math.pow(effBoost, 1.3) * p.turboWhineGain * 0.13 * this.camIntake;
        }
      }

      // === ELECTRIC HYPERCAR DUAL-MOTOR INVERTER & TURBINE (Tesla Roadster) ===
      let evSig = 0;
      if (evBlend > 0.02) {
        const spdNorm = Math.max(0, Math.min(1.25, this.speed / 82));
        const baseEv = 155 + Math.max(rpmNorm * 0.65, spdNorm * 0.95) * 1980;
        this.evPhase1 += (baseEv / sr) * Math.PI * 2;
        this.evPhase2 += ((baseEv * 1.503) / sr) * Math.PI * 2;
        this.evPhase3 += ((baseEv * 2.006) / sr) * Math.PI * 2;
        if (this.evPhase1 > Math.PI * 2) this.evPhase1 -= Math.PI * 2;
        if (this.evPhase2 > Math.PI * 2) this.evPhase2 -= Math.PI * 2;
        if (this.evPhase3 > Math.PI * 2) this.evPhase3 -= Math.PI * 2;
        const torqueMod = 0.25 + effThr * 0.75;
        const inverter =
          Math.sin(this.evPhase1) * 0.52 +
          Math.sin(this.evPhase2) * 0.28 * torqueMod +
          Math.sin(this.evPhase3) * 0.14 * torqueMod;
        const turbineAir = pn * (0.08 + spdNorm * 0.14) * torqueMod;
        const evLvl = evBlend * (0.045 + Math.pow(effThr, 0.85) * 0.24 + spdNorm * 0.18) * this.camIntake;
        evSig = (inverter + turbineAir) * evLvl;
      }

      // Combine stereo banks (natural ~32% stereo width + centered intake/turbo/ev)
      const combL = (this.lp2L * 0.82 + this.lp2R * 0.18) * combWeight;
      const combR = (this.lp2R * 0.82 + this.lp2L * 0.18) * combWeight;
      const shared = intakeSig + whirSig + turboSig + evSig + starterSig;
      const gain = totalGate * p.outputTrim * this.camLevel * 0.56;

      let rawL = (combL + shared) * gain;
      let rawR = (combR + shared) * gain;

      // Gentle DC blocker + soft safety ceiling (prevents any harsh digital clipping)
      const dcL = rawL - this.dcPrevInL + 0.995 * this.dcPrevOutL;
      this.dcPrevInL = rawL;
      this.dcPrevOutL = dcL;
      const dcR = rawR - this.dcPrevInR + 0.995 * this.dcPrevOutR;
      this.dcPrevInR = rawR;
      this.dcPrevOutR = dcR;

      outL[s] = Math.tanh(dcL * 1.15);
      outR[s] = Math.tanh(dcR * 1.15);
    }
  }
}

class BlendGarageEngineProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.kernel = new PhysicalEngineKernel(sampleRate);
    this.disposed = false;
    this.port.onmessage = (event) => {
      const msg = event.data;
      if (!msg || typeof msg !== 'object') return;
      switch (msg.type) {
        case 'profile':
          this.kernel.setProfile(msg.profile);
          break;
        case 'frame':
          this.kernel.setFrame(msg.frame);
          break;
        case 'ignition':
          this.kernel.triggerIgnition();
          break;
        case 'shift':
          this.kernel.triggerShift(msg.direction, msg.rpm);
          break;
        case 'revPreview':
          this.kernel.triggerRevPreview(msg.profile);
          break;
        case 'dispose':
          this.disposed = true;
          break;
      }
    };
  }

  process(_inputs, outputs) {
    if (this.disposed) return false;
    const output = outputs[0];
    if (!output || output.length === 0) return true;
    const outL = output[0];
    const outR = output.length > 1 ? output[1] : outL;
    this.kernel.processBlock(outL, outR);
    return true;
  }
}

registerProcessor('${ENGINE_WORKLET_NAME}', BlendGarageEngineProcessor);
`;

/**
 * Pure TypeScript wrapper around the exact same `PhysicalEngineKernel` math for deterministic
 * unit testing of the 48 kHz crankshaft combustion + dual-bank exhaust waveguide DSP in Node/Vitest.
 */
export interface PhysicalEngineDspProbe {
  setProfile(profile: EngineAcousticProfile): void;
  setFrame(frame: EngineWorkletFramePayload): void;
  triggerIgnition(): void;
  triggerShift(direction: ShiftDirection, rpm?: number): void;
  triggerRevPreview(profile?: EngineAcousticProfile): void;
  render(frames: number): { left: Float32Array; right: Float32Array };
}

/** Instantiates the worklet's `PhysicalEngineKernel` directly for offline DSP verification in tests. */
export function createPhysicalEngineProbe(sampleRate = 48000): PhysicalEngineDspProbe {
  // Extract only the pure JS PhysicalEngineKernel class (before AudioWorkletProcessor subclass)
  const splitToken = 'class BlendGarageEngineProcessor';
  const kernelEnd = ENGINE_WORKLET_CODE.indexOf(splitToken);
  const kernelSrc = ENGINE_WORKLET_CODE.slice(0, kernelEnd);
  const factory = new Function(`${kernelSrc}; return PhysicalEngineKernel;`) as () => new (sr: number) => {
    setProfile(p: EngineWorkletProfilePayload): void;
    setFrame(f: EngineWorkletFramePayload): void;
    triggerIgnition(): void;
    triggerShift(dir: ShiftDirection, rpm?: number): void;
    triggerRevPreview(p?: EngineWorkletProfilePayload): void;
    processBlock(l: Float32Array, r: Float32Array): void;
  };
  const KernelCtor = factory();
  const kernel = new KernelCtor(sampleRate);

  return {
    setProfile(profile) {
      kernel.setProfile(serializeWorkletProfile(profile));
    },
    setFrame(frame) {
      kernel.setFrame(frame);
    },
    triggerIgnition() {
      kernel.triggerIgnition();
    },
    triggerShift(direction, rpm) {
      kernel.triggerShift(direction, rpm);
    },
    triggerRevPreview(profile) {
      kernel.triggerRevPreview(profile ? serializeWorkletProfile(profile) : undefined);
    },
    render(frames) {
      const len = Math.max(1, Math.floor(frames));
      const left = new Float32Array(len);
      const right = new Float32Array(len);
      const block = 128;
      for (let off = 0; off < len; off += block) {
        const end = Math.min(len, off + block);
        kernel.processBlock(left.subarray(off, end), right.subarray(off, end));
      }
      return { left, right };
    },
  };
}

/**
 * Registers the inline-Blob `AudioWorklet` processor on `ctx` and creates a stereo `AudioWorkletNode`.
 * Returns `null` gracefully if `AudioWorklet` or Blob URLs are unavailable in the current environment.
 */
export async function tryCreateEngineWorkletNode(ctx: AudioContext): Promise<AudioWorkletNode | null> {
  if (
    !ctx.audioWorklet ||
    typeof ctx.audioWorklet.addModule !== 'function' ||
    typeof AudioWorkletNode !== 'function' ||
    typeof Blob === 'undefined' ||
    typeof URL === 'undefined' ||
    typeof URL.createObjectURL !== 'function'
  ) {
    return null;
  }

  let blobUrl: string | null = null;
  try {
    const blob = new Blob([ENGINE_WORKLET_CODE], { type: 'application/javascript' });
    blobUrl = URL.createObjectURL(blob);
    await ctx.audioWorklet.addModule(blobUrl);
    return new AudioWorkletNode(ctx, ENGINE_WORKLET_NAME, {
      numberOfInputs: 0,
      numberOfOutputs: 1,
      outputChannelCount: [2],
    });
  } catch {
    return null;
  } finally {
    if (blobUrl && typeof URL.revokeObjectURL === 'function') {
      try {
        URL.revokeObjectURL(blobUrl);
      } catch {
        // Ignore cleanup errors.
      }
    }
  }
}
