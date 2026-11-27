import type { DriveSurface } from './types';

/** Returns `value` if finite, otherwise `fallback`. */
export function finite(value: number, fallback = 0): number {
  return Number.isFinite(value) ? value : fallback;
}

/** Clamps `value` to `[min, max]`, safely recovering from NaN or Infinity. */
export function clampFinite(value: number, min: number, max: number, fallback = min): number {
  const safe = Number.isFinite(value) ? value : fallback;
  return safe < min ? min : safe > max ? max : safe;
}

/** Linear interpolation with clamped factor. */
export function lerpClamped(a: number, b: number, t: number): number {
  const k = clampFinite(t, 0, 1, 0);
  return a + (b - a) * k;
}

/** Normalizes arbitrary world surface names into canonical `DriveSurface` values. */
export function normalizeDriveSurface(surface: string | undefined | null): DriveSurface {
  switch (surface) {
    case 'asphalt':
      return 'asphalt';
    case 'concrete':
    case 'metal':
    case 'wood':
      return 'concrete';
    case 'gravel':
    case 'dirt':
    case 'sand':
      return 'gravel';
    case 'grass':
      return 'grass';
    default:
      return 'asphalt';
  }
}

/** Smoothly moves an AudioParam toward `value` without clicks or non-finite throws. */
export function safeSetTarget(
  param: AudioParam | undefined | null,
  value: number,
  now: number,
  timeConstant: number,
  min = -1e6,
  max = 1e6,
): void {
  if (!param) return;
  const safeVal = clampFinite(value, min, max, min > 0 ? min : 0);
  const safeNow = Math.max(0, finite(now, 0));
  const safeTc = clampFinite(timeConstant, 0.002, 10, 0.02);
  try {
    param.setTargetAtTime(safeVal, safeNow, safeTc);
  } catch {
    // Never allow a Web Audio parameter scheduling glitch to crash the game loop.
  }
}

/** Sets an AudioParam immediately at `time` with finite clamping. */
export function safeSetValue(
  param: AudioParam | undefined | null,
  value: number,
  time: number,
  min = -1e6,
  max = 1e6,
): void {
  if (!param) return;
  const safeVal = clampFinite(value, min, max, min > 0 ? min : 0);
  const safeTime = Math.max(0, finite(time, 0));
  try {
    param.setValueAtTime(safeVal, safeTime);
  } catch {
    // No-op on closed/invalid contexts.
  }
}

/** Schedules a linear ramp safely. */
export function safeLinearRamp(
  param: AudioParam | undefined | null,
  value: number,
  endTime: number,
  min = -1e6,
  max = 1e6,
): void {
  if (!param) return;
  const safeVal = clampFinite(value, min, max, min > 0 ? min : 0);
  const safeEnd = Math.max(0, finite(endTime, 0));
  try {
    param.linearRampToValueAtTime(safeVal, safeEnd);
  } catch {
    // No-op on closed/invalid contexts.
  }
}

/** Schedules an exponential ramp safely (clamping floor > 0 so Web Audio never throws). */
export function safeExpRamp(
  param: AudioParam | undefined | null,
  value: number,
  endTime: number,
  min = 0.0001,
  max = 1e6,
): void {
  if (!param) return;
  const floor = Math.max(0.0001, finite(min, 0.0001));
  const safeVal = clampFinite(value, floor, Math.max(floor, max), floor);
  const safeEnd = Math.max(0, finite(endTime, 0));
  try {
    param.exponentialRampToValueAtTime(safeVal, safeEnd);
  } catch {
    // No-op on closed/invalid contexts.
  }
}

/** Safely stops a scheduled node and disconnects helper nodes once playback ends. */
export function scheduleStop(
  source: AudioScheduledSourceNode,
  stopTime: number,
  disconnectNodes: readonly AudioNode[] = [],
): void {
  const safeStop = Math.max(0, finite(stopTime, 0));
  const cleanup = () => {
    try {
      source.disconnect();
    } catch {
      // Already disconnected.
    }
    for (const node of disconnectNodes) {
      try {
        node.disconnect();
      } catch {
        // Already disconnected.
      }
    }
  };
  try {
    source.onended = cleanup;
    source.stop(safeStop);
  } catch {
    cleanup();
  }
}

/** Deterministic fast PRNG for repeatable, clean procedural noise buffers. */
function createPrng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = Math.imul(s ^ (s >>> 15), s | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Crossfades the last `fadeSamples` into the start of a buffer so looping is click-free. */
function makeLoopSeamless(data: Float32Array, fadeSamples: number): void {
  const count = Math.min(fadeSamples, Math.floor(data.length / 4));
  if (count <= 1) return;
  for (let i = 0; i < count; i++) {
    const t = i / count;
    const endIdx = data.length - count + i;
    data[i] = data[i] * t + data[endIdx] * (1 - t);
  }
}

export interface AudioNoiseBank {
  readonly white: AudioBuffer;
  readonly pink: AudioBuffer;
  readonly brown: AudioBuffer;
  readonly crackle: AudioBuffer;
}

/**
 * Generates shared, loop-seamless noise buffers once per AudioContext.
 * Reusing these buffers eliminates per-frame and per-event allocations.
 */
export function createNoiseBank(ctx: BaseAudioContext): AudioNoiseBank {
  const sampleRate = clampFinite(ctx.sampleRate, 8000, 192000, 44100);
  const rand = createPrng(0x5a73c109);

  // 2.5 seconds of white noise
  const whiteLen = Math.floor(sampleRate * 2.5);
  const white = ctx.createBuffer(1, whiteLen, sampleRate);
  const whiteData = white.getChannelData(0);
  for (let i = 0; i < whiteLen; i++) {
    whiteData[i] = rand() * 2 - 1;
  }
  makeLoopSeamless(whiteData, Math.floor(sampleRate * 0.04));

  // 3.0 seconds of warm Paul Kellet pink noise
  const pinkLen = Math.floor(sampleRate * 3.0);
  const pink = ctx.createBuffer(1, pinkLen, sampleRate);
  const pinkData = pink.getChannelData(0);
  let b0 = 0;
  let b1 = 0;
  let b2 = 0;
  let b3 = 0;
  let b4 = 0;
  let b5 = 0;
  let b6 = 0;
  for (let i = 0; i < pinkLen; i++) {
    const w = rand() * 2 - 1;
    b0 = 0.99886 * b0 + w * 0.0555179;
    b1 = 0.99332 * b1 + w * 0.0750759;
    b2 = 0.96900 * b2 + w * 0.1538520;
    b3 = 0.86650 * b3 + w * 0.3104856;
    b4 = 0.55000 * b4 + w * 0.5329522;
    b5 = -0.7616 * b5 - w * 0.0168980;
    pinkData[i] = clampFinite((b0 + b1 + b2 + b3 + b4 + b5 + b6 + w * 0.5362) * 0.14, -1, 1, 0);
    b6 = w * 0.115926;
  }
  makeLoopSeamless(pinkData, Math.floor(sampleRate * 0.06));

  // 3.0 seconds of deep Brownian/red noise (DC-blocked)
  const brownLen = Math.floor(sampleRate * 3.0);
  const brown = ctx.createBuffer(1, brownLen, sampleRate);
  const brownData = brown.getChannelData(0);
  let lastOut = 0;
  for (let i = 0; i < brownLen; i++) {
    const w = rand() * 2 - 1;
    lastOut = (lastOut + 0.025 * w) / 1.025;
    brownData[i] = clampFinite(lastOut * 3.2, -1, 1, 0);
  }
  makeLoopSeamless(brownData, Math.floor(sampleRate * 0.08));

  // 2.0 seconds of sparse gritty crackle/pebble noise
  const crackleLen = Math.floor(sampleRate * 2.0);
  const crackle = ctx.createBuffer(1, crackleLen, sampleRate);
  const crackleData = crackle.getChannelData(0);
  for (let i = 0; i < crackleLen; i++) {
    const r = rand();
    if (r > 0.985) {
      crackleData[i] = (rand() * 2 - 1) * 0.95;
    } else if (r > 0.92) {
      crackleData[i] = (rand() * 2 - 1) * 0.32;
    } else {
      crackleData[i] = (rand() * 2 - 1) * 0.05;
    }
  }
  makeLoopSeamless(crackleData, Math.floor(sampleRate * 0.03));

  return { white, pink, brown, crackle };
}

/** Creates an asymmetric warm exhaust saturation curve for `WaveShaperNode`. */
export function createCombustionCurve(drive: number, bias = 0.12, samples = 2048): Float32Array<ArrayBuffer> {
  const curve = new Float32Array(new ArrayBuffer(samples * 4));
  const k = clampFinite(drive, 0.5, 20, 4);
  const asym = clampFinite(bias, 0, 0.45, 0.12);
  const norm = Math.tanh(k) || 1;
  for (let i = 0; i < samples; i++) {
    const x = (i * 2) / (samples - 1) - 1;
    const shifted = x + asym * x * x;
    curve[i] = Math.tanh(k * shifted) / norm;
  }
  return curve;
}

/** Creates a warm brass-like waveshaper curve for the automotive dual-tone horn. */
export function createBrassHornCurve(samples = 1024): Float32Array<ArrayBuffer> {
  const curve = new Float32Array(new ArrayBuffer(samples * 4));
  for (let i = 0; i < samples; i++) {
    const x = (i * 2) / (samples - 1) - 1;
    const y = Math.tanh(x * 2.8) + 0.14 * Math.sin(x * Math.PI);
    curve[i] = clampFinite(y * 0.88, -1, 1, 0);
  }
  return curve;
}

/** Creates an aggressive crunching metallic saturation curve for crash & scrape synthesis. */
export function createMetalCrunchCurve(samples = 1024): Float32Array<ArrayBuffer> {
  const curve = new Float32Array(new ArrayBuffer(samples * 4));
  for (let i = 0; i < samples; i++) {
    const x = (i * 2) / (samples - 1) - 1;
    const hard = Math.tanh(x * 6.5);
    const fold = Math.sin(x * Math.PI * 1.6) * 0.18;
    curve[i] = clampFinite(hard * 0.88 + fold, -1, 1, 0);
  }
  return curve;
}

/** Starts a looping BufferSource connected to `destination`. */
export function createLoopingNoise(
  ctx: AudioContext,
  buffer: AudioBuffer,
  destination: AudioNode,
  playbackRate = 1,
): AudioBufferSourceNode {
  const src = ctx.createBufferSource();
  src.buffer = buffer;
  src.loop = true;
  src.playbackRate.value = clampFinite(playbackRate, 0.25, 4, 1);
  src.connect(destination);
  src.start();
  return src;
}
