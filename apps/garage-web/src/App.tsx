import { useCallback, useEffect, useRef, useState } from 'react';
import { Volume2, VolumeX, X } from 'lucide-react';
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
  const screen = useGarage((s) => s.screen);
  if (!notice) return null;
  return (
    <div
      role={notice.tone === 'error' ? 'alert' : 'status'}
      style={screen === 'shop' ? { left: `calc((100% - ${CHEST_WIDTH}px) / 2)` } : undefined}
      className={`absolute top-5 z-30 flex max-w-[min(460px,70vw)] -translate-x-1/2 select-text items-start gap-3 rounded-md px-4 py-2.5 text-sm shadow-[0_12px_30px_rgb(0_0_0/0.5)] ${
        screen === 'shop' ? '' : 'left-1/2'
      } ${notice.tone === 'error' ? 'bg-chest-700 text-white' : 'bg-paper text-ink'}`}
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

/** Compact mute + volume pill for Selector and Shop screens (DriveScreen has its own inline button). */
function AudioControl() {
  const engine = useEngine();
  const screen = useGarage((s) => s.screen);
  const audio = useGarage((s) => s.audio);
  const [open, setOpen] = useState(false);

  if (screen === 'drive') return null;

  const posStyle = screen === 'shop' ? { right: CHEST_WIDTH + 20, top: 20 } : { right: 32, top: 24 };

  return (
    <div
      className="pointer-events-auto absolute z-10 flex items-center gap-2 rounded-md border border-white/10 bg-steel-900/90 px-2 py-1.5 text-xs text-alu-200 shadow-[0_8px_20px_rgb(0_0_0/0.4)]"
      style={posStyle}
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => setOpen(false)}
    >
      <button
        type="button"
        aria-label={audio.muted ? 'Unmute audio' : 'Mute audio'}
        aria-pressed={audio.muted}
        onClick={() => engine.toggleMute()}
        className={`flex h-6 w-6 items-center justify-center rounded transition-colors ${
          audio.muted ? 'text-chest-400 hover:bg-white/10' : 'text-lift-500 hover:bg-white/10'
        }`}
      >
        {audio.muted ? <VolumeX size={15} /> : <Volume2 size={15} />}
      </button>
      {open ? (
        <label className="flex items-center gap-2 pr-1">
          <span className="sr-only">Master volume</span>
          <input
            type="range"
            min={0}
            max={1}
            step={0.02}
            value={audio.muted ? 0 : audio.volume}
            onChange={(e) => {
              const v = Number(e.target.value);
              if (audio.muted && v > 0) engine.toggleMute();
              engine.setMasterVolume(v);
            }}
            className="slider w-20"
            style={{ ['--fill' as string]: `${Math.round((audio.muted ? 0 : audio.volume) * 100)}%` }}
          />
          <span className="tabular w-7 text-right text-[11px] font-semibold text-alu-300">{Math.round((audio.muted ? 0 : audio.volume) * 100)}%</span>
        </label>
      ) : null}
    </div>
  );
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
      <AudioControl />
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
