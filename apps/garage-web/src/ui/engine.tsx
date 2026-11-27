import { createContext, useContext, useSyncExternalStore } from 'react';
import type { GarageEngine } from '../engine/GarageEngine';
import type { EngineSnapshot } from '../engine/types';

const EngineContext = createContext<GarageEngine | null>(null);

export const EngineProvider = EngineContext.Provider;

/** The engine, for calling its actions. */
export function useEngine(): GarageEngine {
  const engine = useContext(EngineContext);
  if (!engine) throw new Error('useEngine must be used inside <EngineProvider>.');
  return engine;
}

/**
 * Subscribes to one slice of the engine's state. The selector must return a primitive or an object
 * taken straight from the snapshot (never a freshly built one), so the component only re-renders when
 * that slice actually changes.
 */
export function useGarage<T>(selector: (snapshot: EngineSnapshot) => T): T {
  const engine = useEngine();
  return useSyncExternalStore(engine.subscribe, () => selector(engine.getSnapshot()));
}
