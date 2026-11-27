export { SoundEngine } from './SoundEngine';
export { EngineSynth } from './EngineSynth';
export { DrivingFoleySynth } from './DrivingFoleySynth';
export { CrashAudioSynth } from './CrashAudioSynth';
export { GarageFoleySynth } from './GarageFoleySynth';
export {
  ELECTRIC_HYPERCAR_PROFILE,
  ENGINE_PROFILES,
  getEngineProfile,
  isEngineAcousticProfile,
  resolveEngineProfile,
} from './engineProfiles';
export { normalizeDriveSurface } from './dsp';
export type {
  AudioMode,
  AudioStateSnapshot,
  CarProfileHint,
  CrashAudioEvent,
  DriveAudioFrame,
  DriveCameraMode,
  DriveSurface,
  EngineAcousticProfile,
  EngineArchetype,
  EngineHarmonicLayer,
  ShiftDirection,
  SoundEngineOptions,
} from './types';
