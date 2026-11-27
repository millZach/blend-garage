import { normalizeCarBuild, validateCarBuild, type CarBuild, type VehicleManifest } from '@blend-garage/vehicle-core';
import { LIGHTING_MOODS, type LightingMoodId } from './types';

const BUILD_PREFIX = 'blend-garage:build:';
const SESSION_KEY = 'blend-garage:session';

/** The build saved in this browser for a car, repaired against the car's current manifest. */
export function loadSavedBuild(manifest: VehicleManifest): CarBuild | null {
  try {
    const raw = localStorage.getItem(BUILD_PREFIX + manifest.id);
    return raw ? normalizeCarBuild(JSON.parse(raw), manifest) : null;
  } catch {
    return null;
  }
}

/** Returns false when the browser refused the write (storage full or blocked). */
export function saveBuild(build: CarBuild): boolean {
  try {
    localStorage.setItem(BUILD_PREFIX + build.carId, JSON.stringify(build));
    return true;
  } catch {
    return false;
  }
}

export function clearSavedBuild(carId: string): void {
  try {
    localStorage.removeItem(BUILD_PREFIX + carId);
  } catch {
    // Nothing to clear if storage is unavailable.
  }
}

export type ImportResult = { ok: true; build: CarBuild } | { ok: false; error: string };

/** Parses a build file the user picked. Explains exactly why when it cannot be used on this car. */
export function parseBuildFile(text: string, manifest: VehicleManifest): ImportResult {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return { ok: false, error: 'That file is not valid JSON, so it cannot be a build.' };
  }
  if (!validateCarBuild(data)) return { ok: false, error: 'That file is JSON but not a Blend Garage build.' };
  if (data.carId !== manifest.id) {
    return { ok: false, error: `That build is for "${data.carId}". Switch to that car to import it; paint zones and panels do not carry across cars.` };
  }
  const build = normalizeCarBuild(data, manifest);
  return build ? { ok: true, build } : { ok: false, error: 'That build could not be read.' };
}

export interface Session {
  lastCarId: string | null;
  mood: LightingMoodId;
}

export function loadSession(): Session {
  const session: Session = { lastCarId: null, mood: 'daylight' };
  try {
    const raw = JSON.parse(localStorage.getItem(SESSION_KEY) ?? 'null') as Partial<Session> | null;
    if (raw && typeof raw.lastCarId === 'string') session.lastCarId = raw.lastCarId;
    if (raw && LIGHTING_MOODS.some((m) => m.id === raw.mood)) session.mood = raw.mood as LightingMoodId;
  } catch {
    // A corrupt session just means starting from the defaults.
  }
  return session;
}

export function saveSession(session: Session): void {
  try {
    localStorage.setItem(SESSION_KEY, JSON.stringify(session));
  } catch {
    // Remembering the last car is a convenience; losing it is harmless.
  }
}
