import { useCallback, useEffect, useRef, useState } from 'react';
import { X } from 'lucide-react';
import { GarageEngine } from './engine/GarageEngine';
import { BlendGuide } from './ui/BlendGuide';
import { DriveScreen } from './ui/DriveScreen';
import { EngineProvider, useEngine, useGarage } from './ui/engine';
import { SelectorScreen } from './ui/SelectorScreen';
import { CHEST_WIDTH, ShopScreen } from './ui/ShopScreen';

declare global {
  interface Window {
    /** The running engine, exposed in development builds for debugging and automated checks. */
    __garage?: GarageEngine;
  }
}

/** A short message from the engine (saved, imported, something went wrong). */
function Notice() {
  const engine = useEngine();
  const notice = useGarage((s) => s.notice);
  if (!notice) return null;
  return (
    <div
      role={notice.tone === 'error' ? 'alert' : 'status'}
      className={`absolute left-1/2 top-5 z-30 flex max-w-[min(560px,80vw)] -translate-x-1/2 select-text items-start gap-3 rounded-md px-4 py-2.5 text-sm shadow-[0_12px_30px_rgb(0_0_0/0.5)] ${
        notice.tone === 'error' ? 'bg-chest-700 text-white' : 'bg-paper text-ink'
      }`}
    >
      <span className="leading-snug">{notice.text}</span>
      <button type="button" aria-label="Dismiss" onClick={() => engine.dismissNotice()} className="-mr-1 mt-0.5 flex-none rounded opacity-70 hover:opacity-100">
        <X size={15} />
      </button>
    </div>
  );
}

/** Black curtain for the cut back to the Car Selector. */
function Curtain() {
  const curtain = useGarage((s) => s.curtain);
  if (curtain <= 0) return null;
  return <div aria-hidden className="pointer-events-none absolute inset-0 z-20 bg-black" style={{ opacity: curtain }} />;
}

function Hud() {
  const engine = useEngine();
  const screen = useGarage((s) => s.screen);
  const [guideOpen, setGuideOpen] = useState(false);
  const openGuide = useCallback(() => setGuideOpen(true), []);
  const closeGuide = useCallback(() => setGuideOpen(false), []);

  // Tell the camera which parts of the window the panels cover, so the car sits in the middle of the rest.
  useEffect(() => {
    if (screen === 'drive') {
      engine.setViewInsets({ left: 0, right: 0, top: 0, bottom: 0 });
    } else if (screen === 'shop') {
      engine.setViewInsets({ left: 0, right: CHEST_WIDTH, top: 0, bottom: 0 });
    } else {
      engine.setViewInsets({ left: 0, right: 330, top: 150, bottom: 200 });
    }
  }, [engine, screen]);

  return (
    <>
      {screen === 'selector' ? <SelectorScreen onOpenGuide={openGuide} /> : screen === 'shop' ? <ShopScreen onOpenGuide={openGuide} /> : <DriveScreen />}
      <Curtain />
      <Notice />
      {guideOpen ? <BlendGuide onClose={closeGuide} /> : null}
    </>
  );
}

export function App() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [engine, setEngine] = useState<GarageEngine | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const instance = new GarageEngine(canvas);
    instance.start();
    setEngine(instance);
    if (import.meta.env.DEV) window.__garage = instance;
    return () => {
      instance.dispose();
      setEngine(null);
      if (window.__garage === instance) delete window.__garage;
    };
  }, []);

  return (
    <div className="relative h-full w-full overflow-clip">
      <canvas ref={canvasRef} className="absolute inset-0 block h-full w-full touch-none" aria-label="3D view of the garage" />
      {engine ? (
        <EngineProvider value={engine}>
          <Hud />
        </EngineProvider>
      ) : null}
    </div>
  );
}
