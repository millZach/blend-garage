import type { CarProfileHint, EngineAcousticProfile, EngineArchetype } from './types';

/**
 * Physical 4-stroke combustion & dual-bank exhaust waveguide acoustic profiles
 * for every engine archetype in Blend Garage.
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
    pitchScale: 0.94,
    subGain: 0.24,
    harmonics: [
      { ratio: 1.0, waveform: 'sawtooth', baseGain: 0.34, loadGain: 0.22, detuneCents: -3 },
      { ratio: 1.5, waveform: 'triangle', baseGain: 0.16, loadGain: 0.20, detuneCents: 4 },
      { ratio: 2.0, waveform: 'sawtooth', baseGain: 0.18, loadGain: 0.32, detuneCents: 6 },
      { ratio: 3.0, waveform: 'sine', baseGain: 0.08, loadGain: 0.28, detuneCents: -5 },
    ],
    physical: {
      cylinders: 12,
      // Smooth 60-degree 12-cylinder Italian 6-into-2-into-1 firing
      firingAnglesDeg: [0, 60, 120, 180, 240, 300, 360, 420, 480, 540, 600, 660],
      cylinderBanks: [0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1],
      pulseSharpness: 1.28,
      pulseDecayMs: 3.2,
      pulseTurbulence: 0.22,
      cycleJitter: 0.055,
      headerDelayLMs: 0.86,
      headerDelayRMs: 0.91,
      collectorCrossFeed: 0.36,
      tailpipeDelayMs: 2.9,
      pipeFeedback: 0.56,
      pipeDamping: 0.36,
      mufflerResonanceHz: 195,
      mufflerBody: 0.42,
      intakeResonanceHz: 1480,
      crankcaseWhir: 0.18,
    },
    idleLopeDepth: 0.06,
    idleLopeHz: 9.5,
    saturationDrive: 3.8,
    saturationBias: 0.11,
    filterMinHz: 440,
    filterMaxHz: 6200,
    formantMinHz: 920,
    formantMaxHz: 2850,
    formantGainDb: 6.5,
    formantQ: 1.9,
    inductionGain: 0.42,
    hasTurbo: false,
    turboWhineGain: 0,
    turboPitchRange: [2000, 5200],
    bovIntensity: 0,
    crackleIntensity: 0.88,
    shiftPopIntensity: 0.96,
    starterCrankHz: 118,
    outputTrim: 0.96,
  },

  /** Raspy 4.0L NA Flat-6 — Porsche 911 GT3 RS motorsport boxer howl. */
  flat6: {
    id: 'flat6',
    label: 'Motorsport Flat-6',
    archetype: 'flat6',
    idleRpm: 950,
    redlineRpm: 9000,
    firingOrder: 3.0,
    pitchScale: 1.06,
    subGain: 0.22,
    harmonics: [
      { ratio: 1.0, waveform: 'sawtooth', baseGain: 0.36, loadGain: 0.24, detuneCents: -5 },
      { ratio: 1.5, waveform: 'sawtooth', baseGain: 0.24, loadGain: 0.28, detuneCents: 7 },
      { ratio: 2.0, waveform: 'triangle', baseGain: 0.20, loadGain: 0.26, detuneCents: -4 },
      { ratio: 2.5, waveform: 'sawtooth', baseGain: 0.10, loadGain: 0.30, detuneCents: 9 },
    ],
    physical: {
      cylinders: 6,
      // 120-degree boxer firing across opposed left/right cylinder banks
      firingAnglesDeg: [0, 120, 240, 360, 480, 600],
      cylinderBanks: [0, 1, 0, 1, 0, 1],
      pulseSharpness: 1.42,
      pulseDecayMs: 3.6,
      pulseTurbulence: 0.28,
      cycleJitter: 0.08,
      // Slightly unequal boxer header lengths give the signature dry GT3 metallic rasp
      headerDelayLMs: 1.04,
      headerDelayRMs: 1.24,
      collectorCrossFeed: 0.28,
      tailpipeDelayMs: 3.55,
      pipeFeedback: 0.58,
      pipeDamping: 0.38,
      mufflerResonanceHz: 215,
      mufflerBody: 0.45,
      intakeResonanceHz: 1220,
      crankcaseWhir: 0.24,
    },
    idleLopeDepth: 0.12,
    idleLopeHz: 11.2,
    saturationDrive: 4.5,
    saturationBias: 0.18,
    filterMinHz: 420,
    filterMaxHz: 6000,
    formantMinHz: 720,
    formantMaxHz: 2350,
    formantGainDb: 7.2,
    formantQ: 2.2,
    inductionGain: 0.38,
    hasTurbo: false,
    turboWhineGain: 0,
    turboPitchRange: [2000, 5200],
    bovIntensity: 0,
    crackleIntensity: 0.92,
    shiftPopIntensity: 0.86,
    starterCrankHz: 112,
    outputTrim: 0.98,
  },

  /** Turbocharged 3.0L Inline-6 — Toyota Supra (2JZ-GTE) with loud turbo spool & BOV flutter. */
  'i6-turbo': {
    id: 'i6-turbo',
    label: 'Turbocharged Inline-6',
    archetype: 'i6-turbo',
    idleRpm: 850,
    redlineRpm: 7600,
    firingOrder: 3.0,
    pitchScale: 1.0,
    subGain: 0.32,
    harmonics: [
      { ratio: 1.0, waveform: 'sawtooth', baseGain: 0.40, loadGain: 0.22, detuneCents: -2 },
      { ratio: 2.0, waveform: 'triangle', baseGain: 0.26, loadGain: 0.28, detuneCents: 3 },
      { ratio: 3.0, waveform: 'sawtooth', baseGain: 0.12, loadGain: 0.24, detuneCents: -3 },
      { ratio: 4.0, waveform: 'sine', baseGain: 0.06, loadGain: 0.18, detuneCents: 4 },
    ],
    physical: {
      cylinders: 6,
      // Single-bank silky 120-degree 2JZ Inline-6 feeding a twin-scroll turbo downpipe
      firingAnglesDeg: [0, 120, 240, 360, 480, 600],
      cylinderBanks: [0, 0, 0, 0, 0, 0],
      pulseSharpness: 1.02,
      pulseDecayMs: 4.8,
      pulseTurbulence: 0.26,
      cycleJitter: 0.055,
      headerDelayLMs: 1.38,
      headerDelayRMs: 1.46,
      collectorCrossFeed: 0.48,
      tailpipeDelayMs: 5.3,
      pipeFeedback: 0.47,
      pipeDamping: 0.58,
      mufflerResonanceHz: 142,
      mufflerBody: 0.56,
      intakeResonanceHz: 820,
      crankcaseWhir: 0.14,
    },
    idleLopeDepth: 0.06,
    idleLopeHz: 8.4,
    saturationDrive: 3.6,
    saturationBias: 0.14,
    filterMinHz: 340,
    filterMaxHz: 4600,
    formantMinHz: 460,
    formantMaxHz: 1750,
    formantGainDb: 5.8,
    formantQ: 1.8,
    inductionGain: 0.32,
    hasTurbo: true,
    turboWhineGain: 0.9,
    turboPitchRange: [1800, 6900],
    bovIntensity: 0.96,
    crackleIntensity: 0.80,
    shiftPopIntensity: 0.86,
    starterCrankHz: 96,
    outputTrim: 1.0,
  },

  /** Deep cross-plane American V8 — Classic Corvettes (C3/C4/C5), Dodge Challenger, muscle cars. */
  'v8-muscle': {
    id: 'v8-muscle',
    label: 'Cross-Plane V8 Muscle',
    archetype: 'v8-muscle',
    idleRpm: 700,
    redlineRpm: 6500,
    firingOrder: 4.0,
    pitchScale: 0.78,
    subGain: 0.48,
    harmonics: [
      { ratio: 0.75, waveform: 'sawtooth', baseGain: 0.28, loadGain: 0.20, detuneCents: -8 },
      { ratio: 1.0, waveform: 'sawtooth', baseGain: 0.38, loadGain: 0.24, detuneCents: 5 },
      { ratio: 1.25, waveform: 'triangle', baseGain: 0.22, loadGain: 0.22, detuneCents: -6 },
      { ratio: 2.0, waveform: 'sawtooth', baseGain: 0.12, loadGain: 0.24, detuneCents: 7 },
    ],
    physical: {
      cylinders: 8,
      // Authentic 90-degree cross-plane V8 firing order (1-8-4-3-6-5-7-2 -> L-R-L-L-R-L-R-R!)
      // Consecutive same-bank double pulses (L-L and R-R) create the unmistakable V8 lope & thunder!
      firingAnglesDeg: [0, 90, 180, 270, 360, 450, 540, 630],
      cylinderBanks: [0, 1, 0, 0, 1, 0, 1, 1],
      pulseSharpness: 0.95,
      pulseDecayMs: 7.4,
      pulseTurbulence: 0.32,
      cycleJitter: 0.13,
      headerDelayLMs: 1.52,
      headerDelayRMs: 1.78,
      collectorCrossFeed: 0.22,
      tailpipeDelayMs: 6.9,
      pipeFeedback: 0.54,
      pipeDamping: 0.66,
      mufflerResonanceHz: 108,
      mufflerBody: 0.72,
      intakeResonanceHz: 520,
      crankcaseWhir: 0.12,
    },
    idleLopeDepth: 0.28,
    idleLopeHz: 7.2,
    saturationDrive: 4.8,
    saturationBias: 0.25,
    filterMinHz: 260,
    filterMaxHz: 3700,
    formantMinHz: 195,
    formantMaxHz: 1020,
    formantGainDb: 7.0,
    formantQ: 1.6,
    inductionGain: 0.24,
    hasTurbo: false,
    turboWhineGain: 0,
    turboPitchRange: [1600, 4800],
    bovIntensity: 0,
    crackleIntensity: 0.76,
    shiftPopIntensity: 0.78,
    starterCrankHz: 76,
    outputTrim: 1.04,
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
    physical: {
      cylinders: 8,
      // 180-degree flat-plane exotic V8: strictly alternating L-R-L-R-L-R-L-R for a razor-sharp scream
      firingAnglesDeg: [0, 90, 180, 270, 360, 450, 540, 630],
      cylinderBanks: [0, 1, 0, 1, 0, 1, 0, 1],
      pulseSharpness: 1.26,
      pulseDecayMs: 4.4,
      pulseTurbulence: 0.25,
      cycleJitter: 0.075,
      headerDelayLMs: 1.12,
      headerDelayRMs: 1.19,
      collectorCrossFeed: 0.32,
      tailpipeDelayMs: 4.2,
      pipeFeedback: 0.55,
      pipeDamping: 0.45,
      mufflerResonanceHz: 158,
      mufflerBody: 0.52,
      intakeResonanceHz: 1050,
      crankcaseWhir: 0.18,
    },
    idleLopeDepth: 0.11,
    idleLopeHz: 8.8,
    saturationDrive: 4.2,
    saturationBias: 0.17,
    filterMinHz: 350,
    filterMaxHz: 5100,
    formantMinHz: 440,
    formantMaxHz: 1950,
    formantGainDb: 6.4,
    formantQ: 1.9,
    inductionGain: 0.34,
    hasTurbo: false,
    turboWhineGain: 0,
    turboPitchRange: [1800, 5400],
    bovIntensity: 0,
    crackleIntensity: 0.84,
    shiftPopIntensity: 0.90,
    starterCrankHz: 94,
    outputTrim: 1.0,
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
    physical: {
      cylinders: 10,
      // Authentic odd-fire 54°/90° V10 crank cadence — creates the unmistakable haunting V10 wail!
      firingAnglesDeg: [0, 54, 144, 198, 288, 342, 432, 486, 576, 630],
      cylinderBanks: [0, 1, 0, 1, 0, 1, 0, 1, 0, 1],
      pulseSharpness: 1.32,
      pulseDecayMs: 3.7,
      pulseTurbulence: 0.24,
      cycleJitter: 0.068,
      headerDelayLMs: 0.96,
      headerDelayRMs: 1.07,
      collectorCrossFeed: 0.34,
      tailpipeDelayMs: 3.4,
      pipeFeedback: 0.56,
      pipeDamping: 0.39,
      mufflerResonanceHz: 182,
      mufflerBody: 0.46,
      intakeResonanceHz: 1340,
      crankcaseWhir: 0.20,
    },
    idleLopeDepth: 0.09,
    idleLopeHz: 9.2,
    saturationDrive: 4.1,
    saturationBias: 0.15,
    filterMinHz: 400,
    filterMaxHz: 5800,
    formantMinHz: 780,
    formantMaxHz: 2550,
    formantGainDb: 6.8,
    formantQ: 2.0,
    inductionGain: 0.38,
    hasTurbo: false,
    turboWhineGain: 0,
    turboPitchRange: [2000, 5600],
    bovIntensity: 0,
    crackleIntensity: 0.85,
    shiftPopIntensity: 0.92,
    starterCrankHz: 108,
    outputTrim: 0.98,
  },
};

/**
 * Tailored futuristic hypercar acoustic profile for electric vehicles (e.g. Tesla Roadster 2026).
 * Preserves the strict `EngineArchetype` union ('v10') while engaging dual/tri-motor
 * sinusoidal inverter whine & planetary-gear turbine rush.
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
  subGain: 0.06,
  harmonics: [
    { ratio: 1.0, waveform: 'sine', baseGain: 0.08, loadGain: 0.14, detuneCents: 0 },
    { ratio: 2.0, waveform: 'triangle', baseGain: 0.05, loadGain: 0.14, detuneCents: 3 },
    { ratio: 3.0, waveform: 'sine', baseGain: 0.04, loadGain: 0.12, detuneCents: -3 },
    { ratio: 4.0, waveform: 'sine', baseGain: 0.03, loadGain: 0.10, detuneCents: 5 },
  ],
  physical: {
    ...ENGINE_PROFILES.v10.physical,
    pulseTurbulence: 0.04,
    cycleJitter: 0.01,
    pipeFeedback: 0.18,
    pipeDamping: 0.5,
    mufflerBody: 0.1,
    crankcaseWhir: 0.25,
  },
  idleLopeDepth: 0,
  idleLopeHz: 1,
  saturationDrive: 1.4,
  saturationBias: 0.01,
  filterMinHz: 600,
  filterMaxHz: 6400,
  formantMinHz: 900,
  formantMaxHz: 3400,
  formantGainDb: 3.0,
  formantQ: 1.4,
  inductionGain: 0.18,
  hasTurbo: false,
  turboWhineGain: 0,
  bovIntensity: 0,
  crackleIntensity: 0,
  shiftPopIntensity: 0,
  starterCrankHz: 240,
  outputTrim: 0.90,
  electricWhine: 0.94,
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
    candidate.harmonics.length === 4 &&
    typeof candidate.physical === 'object' &&
    candidate.physical !== null
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
  if (/\b(supercar|exotic|hypercar)\b/.test(text)) {
    return ENGINE_PROFILES.v10;
  }

  return ENGINE_PROFILES.v10;
}
