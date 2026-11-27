import { clampFinite } from './dsp';

function createPrng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = Math.imul(s ^ (s >>> 15), s | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Generates a short (~62 ms) stereo outdoor exhaust-cabinet & asphalt ground-bounce impulse response.
 * Placed subtly in parallel with the engine tailpipe so the car sounds physically miked in open air
 * rather than dry headphones synthesis.
 */
export function createExhaustOutdoorIR(ctx: BaseAudioContext): AudioBuffer {
  const sampleRate = clampFinite(ctx.sampleRate, 8000, 192000, 44100);
  const durationSec = 0.064;
  const length = Math.max(64, Math.floor(sampleRate * durationSec));
  const buffer = ctx.createBuffer(2, length, sampleRate);
  const rand = createPrng(0x2f81b39d);

  // Early reflections: direct tailpipe exit, rear diffuser / bumper cavity, asphalt bounce, near ambient
  const tapsL: [number, number][] = [
    [0.0004, 0.72],
    [0.0021, -0.34],
    [0.0046, 0.28],
    [0.0092, -0.20],
    [0.0158, 0.14],
    [0.0255, -0.09],
  ];
  const tapsR: [number, number][] = [
    [0.0005, 0.72],
    [0.0026, -0.32],
    [0.0054, 0.26],
    [0.0104, -0.19],
    [0.0176, 0.13],
    [0.0278, -0.08],
  ];

  for (let ch = 0; ch < 2; ch++) {
    const data = buffer.getChannelData(ch);
    const taps = ch === 0 ? tapsL : tapsR;

    // Warm diffused open-air asphalt scatter
    let lp = 0;
    for (let i = 0; i < length; i++) {
      const t = i / sampleRate;
      const env = Math.exp(-t * 58) * (1 - Math.exp(-t * 900));
      const white = rand() * 2 - 1;
      lp += (white - lp) * 0.34;
      data[i] = lp * env * 0.24;
    }

    for (const [tapSec, gain] of taps) {
      const idx = Math.min(length - 2, Math.floor(tapSec * sampleRate));
      if (idx >= 0) {
        data[idx] += gain;
        // Soft 2-sample smear to avoid metallic comb spikes
        data[idx + 1] += gain * 0.35;
      }
    }
  }

  return buffer;
}

/**
 * Generates a rich (~520 ms) stereo concrete mountain-tunnel impulse response.
 * Features tight opposing concrete wall slapbacks, slight stereo decorrelation,
 * warm low-mid bore resonance, and progressive high-frequency air absorption.
 */
export function createTunnelReverbIR(ctx: BaseAudioContext): AudioBuffer {
  const sampleRate = clampFinite(ctx.sampleRate, 8000, 192000, 44100);
  const durationSec = 0.52;
  const length = Math.max(256, Math.floor(sampleRate * durationSec));
  const buffer = ctx.createBuffer(2, length, sampleRate);
  const rand = createPrng(0x7c4e91a3);

  // Concrete tunnel wall/ceiling early flutter echoes
  const wallTapsL: [number, number][] = [
    [0.0075, 0.56],
    [0.0162, -0.44],
    [0.0274, 0.36],
    [0.0415, -0.28],
    [0.0580, 0.22],
    [0.0790, -0.17],
    [0.1040, 0.13],
  ];
  const wallTapsR: [number, number][] = [
    [0.0086, 0.54],
    [0.0181, -0.42],
    [0.0302, 0.35],
    [0.0448, -0.27],
    [0.0625, 0.21],
    [0.0842, -0.16],
    [0.1110, 0.12],
  ];

  for (let ch = 0; ch < 2; ch++) {
    const data = buffer.getChannelData(ch);
    const taps = ch === 0 ? wallTapsL : wallTapsR;

    let lp1 = 0;
    let lp2 = 0;
    for (let i = 0; i < length; i++) {
      const t = i / sampleRate;
      const progress = t / durationSec;
      const env = Math.exp(-t * 6.8) * (1 - Math.exp(-t * 140));
      const white = rand() * 2 - 1;
      // Progressive HF damping as sound bounces further down the concrete tunnel bore
      const alpha = clampFinite(0.52 - progress * 0.36, 0.12, 0.55, 0.3);
      lp1 += (white - lp1) * alpha;
      lp2 += (lp1 - lp2) * (alpha * 0.85);
      data[i] = lp2 * env * 0.42;
    }

    for (const [tapSec, gain] of taps) {
      const idx = Math.min(length - 3, Math.floor(tapSec * sampleRate));
      if (idx >= 0) {
        data[idx] += gain * 0.48;
        data[idx + 1] += gain * 0.28;
        data[idx + 2] += gain * 0.12;
      }
    }
  }

  return buffer;
}

/**
 * Safely creates a `ConvolverNode` loaded with `buffer`.
 * Returns `null` if the AudioContext mock/environment does not support `createConvolver`.
 */
export function tryCreateConvolver(ctx: AudioContext, buffer: AudioBuffer): ConvolverNode | null {
  if (typeof ctx.createConvolver !== 'function') return null;
  try {
    const convolver = ctx.createConvolver();
    convolver.normalize = true;
    convolver.buffer = buffer;
    return convolver;
  } catch {
    return null;
  }
}
