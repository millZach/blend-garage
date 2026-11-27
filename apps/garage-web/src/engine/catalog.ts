import { validateVehicleManifest, type GarageManifest, type VehicleManifest } from '@blend-garage/vehicle-core';
import type { CatalogCar } from './types';

const rawBase = import.meta.env?.BASE_URL ?? '/';
const BASE_URL = rawBase.endsWith('/') ? rawBase : `${rawBase}/`;

/** Resolves an app-relative public path (e.g. `/cars/manifest.json` or `/draco/`) against Vite's `BASE_URL`. */
export function withBase(path: string): string {
  if (/^(?:[a-z]+:)?\/\//i.test(path) || path.startsWith('data:') || path.startsWith('blob:')) return path;
  if (BASE_URL !== '/' && path.startsWith(BASE_URL)) return path;
  return `${BASE_URL}${path.replace(/^\/+/, '')}`;
}

const CATALOG_URL = withBase('/cars/manifest.json');

/**
 * Tidies the names the importer derives from file names: model codes such as "Lp700" or "Gt3rs" get
 * their capitals back, and a lone digit after a code is joined to it ("LP700 4" becomes "LP700-4").
 */
export function tidyCarName(raw: string): { name: string; make: string; model: string } {
  const words = raw.trim().split(/\s+/).filter(Boolean);
  const tidy: string[] = [];
  for (const word of words) {
    const isCode = /[a-z]/i.test(word) && /\d/.test(word);
    const previous = tidy[tidy.length - 1];
    if (/^\d$/.test(word) && previous && /[A-Z]\d+$/.test(previous)) tidy[tidy.length - 1] = `${previous}-${word}`;
    else tidy.push(isCode ? word.toUpperCase() : word);
  }
  const name = tidy.join(' ') || 'Unnamed car';
  return { name, make: tidy[0] ?? '', model: tidy.slice(1).join(' ') || name };
}

async function fetchJson(url: string, what: string): Promise<unknown> {
  let response: Response;
  try {
    response = await fetch(url, { cache: 'no-store' });
  } catch {
    throw new Error(`${what} could not be reached. Check that the dev server is still running.`);
  }
  if (!response.ok) throw new Error(`${what} is missing (HTTP ${response.status}). Run "npm run import-cars" to generate it.`);
  try {
    return await response.json();
  } catch {
    throw new Error(`${what} is not valid JSON. Run "npm run import-cars" to regenerate it.`);
  }
}

/** Reads the list of imported cars. Manifests are fetched separately (see `fetchVehicleManifest`). */
export async function fetchCatalog(): Promise<CatalogCar[]> {
  const data = (await fetchJson(CATALOG_URL, 'The car list (/cars/manifest.json)')) as Partial<GarageManifest> | null;
  if (!data || data.schemaVersion !== 1 || !Array.isArray(data.cars)) {
    throw new Error('The car list (/cars/manifest.json) is not in the expected format. Run "npm run import-cars" to regenerate it.');
  }
  return data.cars
    .filter((car) => car && typeof car.id === 'string' && typeof car.vehicleUrl === 'string' && typeof car.modelUrl === 'string')
    .map((car) => ({
      id: car.id,
      ...tidyCarName(typeof car.name === 'string' ? car.name : car.id),
      author: typeof car.author === 'string' ? car.author : '',
      vehicleUrl: withBase(car.vehicleUrl),
      modelUrl: withBase(car.modelUrl),
      importedAt: typeof car.importedAt === 'string' ? car.importedAt : '',
      manifest: null,
    }));
}

export async function fetchVehicleManifest(car: Pick<CatalogCar, 'id' | 'name' | 'vehicleUrl'>): Promise<VehicleManifest> {
  const url = withBase(car.vehicleUrl);
  const data = await fetchJson(url, `The description of ${car.name} (${url})`);
  if (!validateVehicleManifest(data)) {
    throw new Error(`The description of ${car.name} (${url}) is not a valid vehicle manifest. Re-import the car with "npm run import-cars".`);
  }
  return { ...data, modelUrl: withBase(data.modelUrl) };
}
