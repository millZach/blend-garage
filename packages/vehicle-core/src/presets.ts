import type { PaintFinishType, PaintZoneState } from './schema.js';

export interface PaintPreset {
  id: string;
  name: string;
  state: PaintZoneState;
}

export const FINISH_PROFILES: Record<
  PaintFinishType,
  Pick<PaintZoneState, 'metalness' | 'roughness' | 'clearcoat' | 'clearcoatRoughness' | 'iridescence'>
> = {
  gloss: {
    metalness: 0.18,
    roughness: 0.16,
    clearcoat: 1.0,
    clearcoatRoughness: 0.05,
    iridescence: 0.0,
  },
  metallic: {
    metalness: 0.78,
    roughness: 0.24,
    clearcoat: 1.0,
    clearcoatRoughness: 0.06,
    iridescence: 0.08,
  },
  satin: {
    metalness: 0.42,
    roughness: 0.36,
    clearcoat: 0.35,
    clearcoatRoughness: 0.32,
    iridescence: 0.0,
  },
  matte: {
    metalness: 0.12,
    roughness: 0.68,
    clearcoat: 0.0,
    clearcoatRoughness: 0.6,
    iridescence: 0.0,
  },
  pearlescent: {
    metalness: 0.68,
    roughness: 0.18,
    clearcoat: 1.0,
    clearcoatRoughness: 0.04,
    iridescence: 0.85,
  },
  chrome: {
    metalness: 1.0,
    roughness: 0.06,
    clearcoat: 0.6,
    clearcoatRoughness: 0.04,
    iridescence: 0.1,
  },
};

export const AUTOMOTIVE_PAINT_PRESETS: PaintPreset[] = [
  {
    id: 'rosso-corsa',
    name: 'Rosso Corsa',
    state: { color: '#c81d25', finish: 'gloss', ...FINISH_PROFILES.gloss },
  },
  {
    id: 'midnight-sapphire',
    name: 'Midnight Sapphire',
    state: { color: '#14387d', finish: 'metallic', ...FINISH_PROFILES.metallic },
  },
  {
    id: 'british-emerald',
    name: 'British Racing Green',
    state: { color: '#0e4a35', finish: 'metallic', ...FINISH_PROFILES.metallic },
  },
  {
    id: 'nardo-grey',
    name: 'Nardo Grey',
    state: { color: '#7a8087', finish: 'gloss', ...FINISH_PROFILES.gloss },
  },
  {
    id: 'championship-white',
    name: 'Championship White',
    state: { color: '#f2f0e8', finish: 'gloss', ...FINISH_PROFILES.gloss },
  },
  {
    id: 'stealth-obsidian',
    name: 'Stealth Obsidian',
    state: { color: '#1b1e23', finish: 'matte', ...FINISH_PROFILES.matte },
  },
  {
    id: 'papaya-spark',
    name: 'Papaya Spark',
    state: { color: '#f05a1a', finish: 'metallic', ...FINISH_PROFILES.metallic },
  },
  {
    id: 'midnight-purple-pearl',
    name: 'Midnight Purple Pearl',
    state: { color: '#3b1d6b', finish: 'pearlescent', ...FINISH_PROFILES.pearlescent },
  },
  {
    id: 'miami-cyan',
    name: 'Miami Blue',
    state: { color: '#009bc2', finish: 'gloss', ...FINISH_PROFILES.gloss },
  },
  {
    id: 'solar-gold',
    name: 'Solar Gold',
    state: { color: '#d9a426', finish: 'metallic', ...FINISH_PROFILES.metallic },
  },
  {
    id: 'satin-titanium',
    name: 'Satin Titanium',
    state: { color: '#8e96a0', finish: 'satin', ...FINISH_PROFILES.satin },
  },
  {
    id: 'liquid-chrome',
    name: 'Liquid Chrome',
    state: { color: '#e4e8ee', finish: 'chrome', ...FINISH_PROFILES.chrome },
  },
];

export const RIM_FINISH_PRESETS: PaintPreset[] = [
  {
    id: 'machined-silver',
    name: 'Machined Silver',
    state: { color: '#d7dce2', finish: 'metallic', ...FINISH_PROFILES.metallic },
  },
  {
    id: 'satin-bronze',
    name: 'Satin Bronze',
    state: { color: '#8c6b43', finish: 'satin', ...FINISH_PROFILES.satin },
  },
  {
    id: 'gloss-black',
    name: 'Gloss Black',
    state: { color: '#16181c', finish: 'gloss', ...FINISH_PROFILES.gloss },
  },
  {
    id: 'rally-gold',
    name: 'Rally Gold',
    state: { color: '#c9972c', finish: 'metallic', ...FINISH_PROFILES.metallic },
  },
  {
    id: 'gunmetal',
    name: 'Gunmetal',
    state: { color: '#4c535e', finish: 'satin', ...FINISH_PROFILES.satin },
  },
];
