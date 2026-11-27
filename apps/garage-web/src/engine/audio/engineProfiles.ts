import type { CarProfileHint, EngineAcousticProfile, EngineArchetype } from './types';

/**
 * Studio-tuned procedural acoustic profiles for each core automotive engine archetype.
 * Firing order, harmonic ratios, formant center frequencies, saturation drive, and
 * turbo/crackle behaviors are modeled after real-world exhaust & induction acoustics.
 */
export const ENGINE_PROFILES: Readonly<Record<EngineArchetype, EngineAcousticProfile>> = {
  /** Screaming 6.5L NA V12 — Lamborghini Aventador LP700-4, Italian exotics. */
  v12: {
    id: 'v12',
    label: 'Naturally Aspirated V12',
    archetype: 'v12',
    idleRpm: 900,
    redlineRpm: 8500,
    firingOrder: 6.0,
    pitchScale: 0.92,
    subGain: 0.24,
    harmonics: [
      { ratio: 1.0, waveform: 'sawtooth', baseGain: 0.34, loadGain: 0.22, detuneCents: -3 },
      { ratio: 1.5, waveform: 'triangle', baseGain: 0.16, loadGain: 0.20, detuneCents: 4 },
      { ratio: 2.0, waveform: 'sawtooth', baseGain: 0.18, loadGain: 0.32, detuneCents: 6 },
      { ratio: 3.0, waveform: 'sine', baseGain: 0.08, loadGain: 0.28, detuneCents: -5 },
    ],
    idleLopeDepth: 0.08,
    idleLopeHz: 9.5,
    saturationDrive: 4.8,
    saturationBias: 0.11,
    filterMinHz: 420,
    filterMaxHz: 5400,
    formantMinHz: 920,
    formantMaxHz: 2650,
    formantGainDb: 7.5,
    formantQ: 2.1,
    inductionGain: 0.38,
    hasTurbo: false,
    turboWhineGain: 0,
    turboPitchRange: [2000, 5200],
    bovIntensity: 0,
    crackleIntensity: 0.85,
    shiftPopIntensity: 0.95,
    starterCrankHz: 118,
    outputTrim: 0.94,
  },

  /** Raspy 4.0L NA Flat-6 — Porsche 911 GT3 RS motorsport boxer howl. */
  flat6: {
    id: 'flat6',
    label: 'Motorsport Flat-6',
    archetype: 'flat6',
    idleRpm: 950,
    redlineRpm: 9000,
    firingOrder: 3.0,
    pitchScale: 1.08,
    subGain: 0.22,
    harmonics: [
      { ratio: 1.0, waveform: 'sawtooth', baseGain: 0.36, loadGain: 0.24, detuneCents: -5 },
      { ratio: 1.5, waveform: 'sawtooth', baseGain: 0.24, loadGain: 0.28, detuneCents: 7 },
      { ratio: 2.0, waveform: 'triangle', baseGain: 0.20, loadGain: 0.26, detuneCents: -4 },
      { ratio: 2.5, waveform: 'sawtooth', baseGain: 0.10, loadGain: 0.30, detuneCents: 9 },
    ],
    idleLopeDepth: 0.14,
    idleLopeHz: 11.2,
    saturationDrive: 5.6,
    saturationBias: 0.18,
    filterMinHz: 390,
    filterMaxHz: 5200,
    formantMinHz: 680,
    formantMaxHz: 2150,
    formantGainDb: 8.5,
    formantQ: 2.6,
    inductionGain: 0.34,
    hasTurbo: false,
    turboWhineGain: 0,
    turboPitchRange: [2000, 5200],
    bovIntensity: 0,
    crackleIntensity: 0.9,
    shiftPopIntensity: 0.82,
    starterCrankHz: 112,
    outputTrim: 0.96,
  },

  /** Turbocharged 3.0L Inline-6 — Toyota Supra (2JZ-GTE) with loud turbo spool & BOV flutter. */
  'i6-turbo': {
    id: 'i6-turbo',
    label: 'Turbocharged Inline-6',
    archetype: 'i6-turbo',
    idleRpm: 850,
    redlineRpm: 7600,
    firingOrder: 3.0,
    pitchScale: 1.02,
    subGain: 0.32,
    harmonics: [
      { ratio: 1.0, waveform: 'sawtooth', baseGain: 0.40, loadGain: 0.22, detuneCents: -2 },
      { ratio: 2.0, waveform: 'triangle', baseGain: 0.26, loadGain: 0.28, detuneCents: 3 },
      { ratio: 3.0, waveform: 'sawtooth', baseGain: 0.12, loadGain: 0.24, detuneCents: -3 },
      { ratio: 4.0, waveform: 'sine', baseGain: 0.06, loadGain: 0.18, detuneCents: 4 },
    ],
    idleLopeDepth: 0.07,
    idleLopeHz: 8.4,
    saturationDrive: 4.4,
    saturationBias: 0.14,
    filterMinHz: 320,
    filterMaxHz: 4200,
    formantMinHz: 440,
    formantMaxHz: 1650,
    formantGainDb: 6.5,
    formantQ: 1.9,
    inductionGain: 0.28,
    hasTurbo: true,
    turboWhineGain: 0.85,
    turboPitchRange: [1750, 6900],
    bovIntensity: 0.95,
    crackleIntensity: 0.78,
    shiftPopIntensity: 0.85,
    starterCrankHz: 96,
    outputTrim: 0.98,
  },

  /** Deep cross-plane American V8 — Classic Corvettes (C3/C4/C5), Dodge Challenger, muscle cars. */
  'v8-muscle': {
    id: 'v8-muscle',
    label: 'Cross-Plane V8 Muscle',
    archetype: 'v8-muscle',
    idleRpm: 700,
    redlineRpm: 6500,
    firingOrder: 4.0,
    pitchScale: 0.76,
    subGain: 0.46,
    harmonics: [
      { ratio: 0.75, waveform: 'sawtooth', baseGain: 0.28, loadGain: 0.20, detuneCents: -8 },
      { ratio: 1.0, waveform: 'sawtooth', baseGain: 0.38, loadGain: 0.24, detuneCents: 5 },
      { ratio: 1.25, waveform: 'triangle', baseGain: 0.22, loadGain: 0.22, detuneCents: -6 },
      { ratio: 2.0, waveform: 'sawtooth', baseGain: 0.12, loadGain: 0.24, detuneCents: 7 },
    ],
    idleLopeDepth: 0.30,
    idleLopeHz: 7.4,
    saturationDrive: 6.2,
    saturationBias: 0.26,
    filterMinHz: 250,
    filterMaxHz: 3400,
    formantMinHz: 195,
    formantMaxHz: 980,
    formantGainDb: 8.0,
    formantQ: 1.7,
    inductionGain: 0.20,
    hasTurbo: false,
    turboWhineGain: 0,
    turboPitchRange: [1600, 4800],
    bovIntensity: 0,
    crackleIntensity: 0.72,
    shiftPopIntensity: 0.75,
    starterCrankHz: 78,
    outputTrim: 1.02,
  },

  /** High-revving modern/flat-plane V8 — Corvette C6/C8, Ferrari V8, McLaren, AMG GT. */
  'v8-exotic': {
    id: 'v8-exotic',
    label: 'High-Revving Exotic V8',
    archetype: 'v8-exotic',
    idleRpm: 850,
    redlineRpm: 8200,
    firingOrder: 4.0,
    pitchScale: 0.90,
    subGain: 0.34,
    harmonics: [
      { ratio: 0.75, waveform: 'triangle', baseGain: 0.16, loadGain: 0.14, detuneCents: -4 },
      { ratio: 1.0, waveform: 'sawtooth', baseGain: 0.38, loadGain: 0.26, detuneCents: 3 },
      { ratio: 2.0, waveform: 'sawtooth', baseGain: 0.22, loadGain: 0.30, detuneCents: -5 },
      { ratio: 3.0, waveform: 'triangle', baseGain: 0.10, loadGain: 0.24, detuneCents: 6 },
    ],
    idleLopeDepth: 0.14,
    idleLopeHz: 8.8,
    saturationDrive: 5.2,
    saturationBias: 0.17,
    filterMinHz: 330,
    filterMaxHz: 4600,
    formantMinHz: 420,
    formantMaxHz: 1850,
    formantGainDb: 7.2,
    formantQ: 2.0,
    inductionGain: 0.30,
    hasTurbo: false,
    turboWhineGain: 0,
    turboPitchRange: [1800, 5400],
    bovIntensity: 0,
    crackleIntensity: 0.80,
    shiftPopIntensity: 0.88,
    starterCrankHz: 94,
    outputTrim: 0.98,
  },

  /** Exotic 5.2L V10 — Supercar Original, Huracan, R8, Carrera GT, fallback screamer. */
  v10: {
    id: 'v10',
    label: 'Exotic V10 Screamer',
    archetype: 'v10',
    idleRpm: 900,
    redlineRpm: 8600,
    firingOrder: 5.0,
    pitchScale: 0.95,
    subGain: 0.28,
    harmonics: [
      { ratio: 0.5, waveform: 'triangle', baseGain: 0.20, loadGain: 0.14, detuneCents: -4 },
      { ratio: 1.0, waveform: 'sawtooth', baseGain: 0.36, loadGain: 0.24, detuneCents: 3 },
      { ratio: 1.5, waveform: 'sawtooth', baseGain: 0.20, loadGain: 0.26, detuneCents: -6 },
      { ratio: 2.5, waveform: 'triangle', baseGain: 0.10, loadGain: 0.28, detuneCents: 5 },
    ],
    idleLopeDepth: 0.10,
    idleLopeHz: 9.2,
    saturationDrive: 5.0,
    saturationBias: 0.15,
    filterMinHz: 380,
    filterMaxHz: 5100,
    formantMinHz: 760,
    formantMaxHz: 2400,
    formantGainDb: 7.8,
    formantQ: 2.2,
    inductionGain: 0.35,
    hasTurbo: false,
    turboWhineGain: 0,
    turboPitchRange: [2000, 5600],
    bovIntensity: 0,
    crackleIntensity: 0.82,
    shiftPopIntensity: 0.9,
    starterCrankHz: 108,
    outputTrim: 0.96,
  },
};

/**
 * Tailored futuristic hypercar acoustic profile for electric vehicles (e.g. Tesla Roadster 2026).
 * Preserves the strict `EngineArchetype` union ('v10') while engaging EngineSynth's dual-motor
 * inverter whine & aerospace turbine rush.
 */
export const ELECTRIC_HYPERCAR_PROFILE: Readonly<EngineAcousticProfile> = {
  ...ENGINE_PROFILES.v10,
  id: 'electric-hypercar',
  label: 'Tri-Motor Electric Hypercar',
  archetype: 'v10',
  idleRpm: 600,
  redlineRpm: 12000,
  firingOrder: 4.0,
  pitchScale: 0.8,
  subGain: 0.10,
  harmonics: [
    { ratio: 1.0, waveform: 'sine', baseGain: 0.08, loadGain: 0.14, detuneCents: 0 },
    { ratio: 2.0, waveform: 'triangle', baseGain: 0.05, loadGain: 0.14, detuneCents: 3 },
    { ratio: 3.0, waveform: 'sine', baseGain: 0.04, loadGain: 0.12, detuneCents: -3 },
    { ratio: 4.0, waveform: 'sine', baseGain: 0.03, loadGain: 0.10, detuneCents: 5 },
  ],
  idleLopeDepth: 0,
  idleLopeHz: 1,
  saturationDrive: 1.6,
  saturationBias: 0.02,
  filterMinHz: 600,
  filterMaxHz: 6200,
  formantMinHz: 900,
  formantMaxHz: 3200,
  formantGainDb: 3.5,
  formantQ: 1.6,
  inductionGain: 0.18,
  hasTurbo: false,
  turboWhineGain: 0,
  bovIntensity: 0,
  crackleIntensity: 0,
  shiftPopIntensity: 0,
  starterCrankHz: 240,
  outputTrim: 0.88,
  electricWhine: 0.92,
};

/** Returns the base acoustic profile for a given `EngineArchetype`. */
export function getEngineProfile(archetype: EngineArchetype): EngineAcousticProfile {
  return ENGINE_PROFILES[archetype] ?? ENGINE_PROFILES.v10;
}

/** Type guard for checking whether an unknown object is already an `EngineAcousticProfile`. */
export function isEngineAcousticProfile(value: unknown): value is EngineAcousticProfile {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<EngineAcousticProfile>;
  return (
    typeof candidate.id === 'string' &&
    typeof candidate.archetype === 'string' &&
    typeof candidate.firingOrder === 'number' &&
    Array.isArray(candidate.harmonics) &&
    candidate.harmonics.length === 4
  );
}

/**
 * Resolves a car identifier, name, or category into its tailored `EngineAcousticProfile`.
 * Always returns a valid profile (falling back to exotic `v10`).
 */
export function resolveEngineProfile(hint?: CarProfileHint | EngineAcousticProfile | null): EngineAcousticProfile {
  if (!hint) return ENGINE_PROFILES.v10;
  if (isEngineAcousticProfile(hint)) return hint;

  const raw =
    typeof hint === 'string'
      ? hint
      : `${hint.id ?? ''} ${hint.name ?? ''} ${hint.category ?? ''}`;
  const text = raw.toLowerCase().trim();
  if (!text) return ENGINE_PROFILES.v10;

  // Direct archetype match
  if (text === 'v12' || /\bv12\b/.test(text)) return ENGINE_PROFILES.v12;
  if (text === 'flat6' || /\bflat[-_\s]?6\b/.test(text)) return ENGINE_PROFILES.flat6;
  if (text === 'i6-turbo' || /\bi6[-_\s]?turbo\b/.test(text)) return ENGINE_PROFILES['i6-turbo'];
  if (text === 'v8-muscle' || /\bv8[-_\s]?muscle\b/.test(text)) return ENGINE_PROFILES['v8-muscle'];
  if (text === 'v8-exotic' || /\bv8[-_\s]?exotic\b/.test(text)) return ENGINE_PROFILES['v8-exotic'];
  if (text === 'v10' || /\bv10\b/.test(text)) return ENGINE_PROFILES.v10;

  // Electric hypercars (e.g. Tesla Roadster 2026)
  if (/\b(tesla|roadster|rimac|taycan|ev|electric)\b/.test(text)) {
    return ELECTRIC_HYPERCAR_PROFILE;
  }

  // Exotic V10 screamers (checked before generic Lamborghini V12 so Huracan/Gallardo get V10)
  if (/\b(huracan|gallardo|r8|lfa|viper)\b/.test(text)) {
    return ENGINE_PROFILES.v10;
  }

  // V12 exotics (Lamborghini Aventador, Murcielago, Ferrari V12, Pagani, Aston V12)
  if (/\b(lamborghini|aventador|lp700|murcielago|revuelto|pagani|zonda|huayra|enzo|laferrari|812|f12)\b/.test(text)) {
    return ENGINE_PROFILES.v12;
  }

  // Flat-6 boxer motorsport (Porsche 911 GT3 RS, Carrera, Cayman, Boxer)
  if (/\b(porsche|911|gt3|gt3rs|gt2|carrera|cayman|boxster|boxer)\b/.test(text)) {
    return ENGINE_PROFILES.flat6;
  }

  // Turbocharged Inline-6 (Toyota Supra / 2JZ, Skyline GT-R, BMW M3/M4)
  if (/\b(supra|2jz|skyline|rb26|gt-?r|r34|r35|turbo|rx-?7|silvia|m3|m4|inline[-_\s]?6)\b/.test(text)) {
    return ENGINE_PROFILES['i6-turbo'];
  }

  // Exotic / modern flat-plane V8s (Corvette C6/C7/C8, Ferrari V8, McLaren, AMG GT)
  if (
    (/\bcorvette\b/.test(text) && /\bc[678]\b|\bz06\b|\bzr1\b/.test(text)) ||
    /\b(mclaren|458|488|f8|720s|p1|amg|koenigsegg|bugatti|ferrari)\b/.test(text)
  ) {
    return ENGINE_PROFILES['v8-exotic'];
  }

  // Cross-plane American V8 muscle (Corvette C3/C4/C5, Challenger, Charger, Mustang, Camaro)
  if (/\b(corvette|challenger|charger|dodge|hemi|hellcat|mustang|camaro|shelby|muscle|chevrolet|chevy|pontiac|trans[-_\s]?am|v8)\b/.test(text)) {
    return ENGINE_PROFILES['v8-muscle'];
  }

  // Exotic V10 screamers & supercar fallback (Supercar Original, Huracan, R8, LFA)
  if (/\b(supercar|huracan|gallardo|r8|lfa|viper|exotic|hypercar)\b/.test(text)) {
    return ENGINE_PROFILES.v10;
  }

  return ENGINE_PROFILES.v10;
}
