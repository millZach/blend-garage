import { useState, type ReactNode } from 'react';
import { ArrowDown, ArrowUp, CarFront, RotateCcw, Square } from 'lucide-react';
import { RIM_FINISH_PRESETS, type CarBuild } from '@blend-garage/vehicle-core';
import { CAMERA_PRESETS, LIGHTING_MOODS, type CameraMode } from '../engine/types';
import { AeroDrawer } from './drawers/AeroDrawer';
import { PaintDrawer } from './drawers/PaintDrawer';
import { ShopDrawer } from './drawers/ShopDrawer';
import { WheelsDrawer } from './drawers/WheelsDrawer';
import { useEngine, useGarage } from './engine';
import { formatClock, formatMillimeters, formatTriangles } from './format';

/** Width of the tool chest, in CSS pixels. The camera centers the car in what is left of the window. */
export const CHEST_WIDTH = 388;

type DrawerId = 'paint' | 'aero' | 'wheels' | 'shop';

const CAMERA_MODES: { id: CameraMode; label: string; hint: string }[] = [
  { id: 'orbit', label: 'Orbit', hint: 'Drag to orbit, scroll to zoom, right-drag to pan.' },
  { id: 'walk', label: 'Walk', hint: 'W A S D to walk, drag to look around, Shift to hurry.' },
  { id: 'fly', label: 'Fly', hint: 'W A S D to fly, Q and E for down and up, drag to look, Shift to go faster.' },
];

function Drawer({ id, open, name, summary, onToggle, children }: { id: DrawerId; open: boolean; name: string; summary: string; onToggle: () => void; children: ReactNode }) {
  return (
    <div className="rounded bg-steel-800 shadow-[inset_0_1px_0_rgb(255_255_255/0.07)]">
      <button type="button" aria-expanded={open} aria-controls={`drawer-${id}`} onClick={onToggle} className="drawer-face block w-full rounded px-3.5 pb-3 text-left">
        <span className="metal-pull -mx-3.5 mb-3 block h-[9px] rounded-t" />
        <span className={`inline-flex min-w-[196px] flex-col rounded-[2px] bg-paper px-2.5 pb-[7px] pt-1.5 text-ink ${open ? 'shadow-[0_0_0_2px_var(--color-lift-500),0_0_0_3px_#101214]' : 'shadow-[0_0_0_2px_#50565c,0_0_0_3px_#101214]'}`}>
          <b className="text-[15px] font-bold leading-tight">{name}</b>
          <span className="text-xs leading-tight text-ink-soft">{summary}</span>
        </span>
      </button>
      {open ? (
        <div id={`drawer-${id}`} className="drawer-tray grid gap-4 border-t border-black bg-steel-850 px-3.5 pb-[18px] pt-3.5">
          {children}
        </div>
      ) : null}
    </div>
  );
}

function useDrawerSummaries(): Record<DrawerId, string> {
  const build = useGarage((s) => s.build);
  const mood = useGarage((s) => s.mood);
  const liftHeight = useGarage((s) => s.lift.height);
  if (!build) return { paint: '', aero: '', wheels: '', shop: '' };

  const painted = Object.values(build.paintZones).filter((zone) => zone.modified).length;
  const paint = painted ? `${painted} ${painted === 1 ? 'material' : 'materials'} repainted` : 'Stock paint';

  const parts = build.universalParts;
  const fitted = [
    parts.spoiler === 'gt-wing' ? 'GT wing' : parts.spoiler === 'ducktail' ? 'ducktail' : parts.spoiler === 'street-lip' ? 'street lip' : parts.spoiler === 'none' ? 'wing delete' : '',
    parts.roof === 'roof-box' ? 'roof box' : parts.roof === 'rally-lightbar' ? 'lightbar' : '',
    parts.frontSplitter ? 'splitter' : '',
    parts.towHook ? 'tow hook' : '',
    parts.exhaustTips ? 'tips' : '',
  ].filter(Boolean);
  const removed = Object.values(build.partVisibility).filter((visible) => !visible).length;
  if (removed) fitted.push(`${removed} ${removed === 1 ? 'panel' : 'panels'} off`);
  const aero = fitted.length ? fitted.join(', ').replace(/^./, (c) => c.toUpperCase()) : 'Stock bodywork';

  const stance = build.stance;
  const wheelBits = [
    parts.wheelStyle === 'stock' ? '' : parts.wheelStyle === 'five-spoke' ? 'five spoke' : parts.wheelStyle === 'mesh-dish' ? 'mesh dish' : 'aero disc',
    build.rimFinish ? (RIM_FINISH_PRESETS.find((p) => p.state.color === build.rimFinish?.color)?.name.toLowerCase() ?? 'custom rims') : '',
    stance.rideHeightOffset ? formatMillimeters(stance.rideHeightOffset, true) : '',
    stance.camberDeg ? `${stance.camberDeg.toFixed(1)}° camber` : '',
  ].filter(Boolean);
  const wheels = wheelBits.length ? wheelBits.join(', ').replace(/^./, (c) => c.toUpperCase()) : 'Stock wheels and stance';

  const moodName = LIGHTING_MOODS.find((m) => m.id === mood)?.label ?? '';
  const shop = `${moodName}, lift ${liftHeight < 0.01 ? 'down' : `at ${liftHeight.toFixed(2)} m`}`;
  return { paint, aero, wheels, shop };
}

function CameraDock() {
  const engine = useEngine();
  const mode = useGarage((s) => s.cameraMode);
  const preset = useGarage((s) => s.cameraPreset);
  const busy = useGarage((s) => s.busy !== null);
  const hint = CAMERA_MODES.find((m) => m.id === mode)?.hint ?? '';
  const group = 'flex w-max gap-0.5 rounded-md bg-steel-900/90 p-[3px]';
  const button = (active: boolean) => `h-8 rounded px-[11px] text-[13px] disabled:opacity-40 ${active ? 'bg-alu-300 font-bold text-steel-900' : 'text-alu-300 hover:bg-white/10 hover:text-white'}`;
  return (
    <div className="pointer-events-auto absolute bottom-6 left-6 grid gap-2">
      <p className="max-w-[420px] rounded bg-steel-900/80 px-2.5 py-1.5 text-xs text-alu-300">{hint}</p>
      <div className={group} role="group" aria-label="Camera mode">
        {CAMERA_MODES.map(({ id, label }) => (
          <button key={id} type="button" disabled={busy} aria-pressed={mode === id} className={button(mode === id)} onClick={() => engine.setCameraMode(id)}>
            {label}
          </button>
        ))}
      </div>
      <div className={group} role="group" aria-label="Camera angle">
        {CAMERA_PRESETS.map(({ id, label }) => (
          <button key={id} type="button" disabled={busy} aria-pressed={preset === id} className={button(preset === id)} onClick={() => engine.goToPreset(id)}>
            {label}
          </button>
        ))}
      </div>
    </div>
  );
}

function LiftPendant() {
  const engine = useEngine();
  const lift = useGarage((s) => s.lift);
  const busy = useGarage((s) => s.busy !== null);
  const rising = lift.moving && lift.target > lift.height;
  const lowering = lift.moving && lift.target < lift.height;
  const button = 'flex h-11 w-full items-center justify-center gap-1.5 rounded-full bg-steel-900 text-[13px] font-bold text-white shadow-[inset_0_-3px_0_rgb(0_0_0/0.6)] hover:bg-steel-700 disabled:opacity-40';
  return (
    <div className="pendant pointer-events-auto absolute bottom-6 w-24 rounded-lg p-2.5 text-center text-[#1c1a10]" style={{ right: CHEST_WIDTH + 24 }}>
      <p className="font-narrow mb-2 text-xs font-bold">Hydraulic lift</p>
      <button type="button" className={button} disabled={busy || (!rising && lift.height >= lift.max - 0.005)} onClick={() => (rising ? engine.stopLift() : engine.setLiftTarget(lift.max))}>
        {rising ? <Square size={12} fill="currentColor" /> : <ArrowUp size={15} />}
        {rising ? 'Stop' : 'Raise'}
      </button>
      <button type="button" className={`${button} mt-1.5`} disabled={busy || (!lowering && lift.height <= 0.005)} onClick={() => (lowering ? engine.stopLift() : engine.setLiftTarget(0))}>
        {lowering ? <Square size={12} fill="currentColor" /> : <ArrowDown size={15} />}
        {lowering ? 'Stop' : 'Lower'}
      </button>
      <p className="tabular mt-2 text-[13px] font-bold" aria-live="off">
        {lift.height.toFixed(2)} m
      </p>
    </div>
  );
}

function PerfReadout() {
  const perf = useGarage((s) => s.perf);
  // Nothing to show until the first second of frames has been measured.
  if (perf.fps === 0) return null;
  return (
    <div className="tabular absolute left-6 top-5 flex gap-4 rounded bg-steel-900/75 px-3 py-1.5 text-xs text-alu-300">
      <span>
        <b className="font-bold text-white">{perf.fps}</b> fps
      </span>
      <span>
        <b className="font-bold text-white">{perf.drawCalls}</b> draw calls
      </span>
      <span>
        <b className="font-bold text-white">{formatTriangles(perf.triangles)}</b> triangles
      </span>
    </div>
  );
}

function countBuildChanges(build: CarBuild | null): number {
  if (!build) return 0;
  let count = 0;
  for (const zone of Object.values(build.paintZones)) if (zone.modified) count += 1;
  for (const visible of Object.values(build.partVisibility)) if (!visible) count += 1;
  const p = build.universalParts;
  if (p.spoiler !== 'stock') count += 1;
  if (p.roof !== 'none') count += 1;
  if (p.wheelStyle !== 'stock') count += 1;
  if (p.frontSplitter) count += 1;
  if (p.towHook) count += 1;
  if (p.exhaustTips) count += 1;
  if (build.rimFinish) count += 1;
  if (build.glassTint) count += 1;
  const s = build.stance;
  if (s.rideHeightOffset !== 0) count += 1;
  if (s.trackOffset !== 0) count += 1;
  if (s.frontSteerAngle !== 0) count += 1;
  if (s.wheelSpinSpeed !== 0) count += 1;
  if (s.camberDeg !== 0) count += 1;
  if (build.lightsOn) count += 1;
  return count;
}

/** The mechanics shop HUD: a tool chest of modification drawers, the camera dock and the lift pendant. */
export function ShopScreen({ onOpenGuide }: { onOpenGuide: () => void }) {
  const engine = useEngine();
  const car = useGarage((s) => s.cars.find((c) => c.id === s.selectedCarId) ?? null);
  const build = useGarage((s) => s.build);
  const savedAt = useGarage((s) => s.savedAt);
  const busy = useGarage((s) => s.busy);
  const [open, setOpen] = useState<DrawerId | null>('paint');
  const summaries = useDrawerSummaries();
  const toggle = (id: DrawerId) => setOpen((current) => (current === id ? null : id));
  const changeCount = countBuildChanges(build);
  const isModified = changeCount > 0 || savedAt !== null;

  return (
    <div className="pointer-events-none absolute inset-0">
      <PerfReadout />
      <CameraDock />
      <LiftPendant />

      <aside className="pointer-events-auto absolute inset-y-0 right-0 flex flex-col border-l border-black bg-steel-900 shadow-[-18px_0_40px_rgb(0_0_0/0.4)]" style={{ width: CHEST_WIDTH }} aria-label="Modification tools">
        <header className="chest-red flex items-center gap-3 px-[18px] pb-3.5 pt-4 text-white">
          <div className="min-w-0 flex-1">
            <h1 className="font-badge truncate text-[17px] font-extrabold uppercase leading-[1.1]">{car?.model ?? 'Car'}</h1>
            <p className="truncate text-xs opacity-85">
              {car?.make}
              {savedAt ? `, saved ${formatClock(savedAt)}` : ', stock'}
            </p>
          </div>
          <button type="button" disabled={busy !== null} onClick={() => void engine.leaveShop()} className="h-[34px] flex-none rounded border border-white/50 bg-black/20 px-3 text-[13px] font-semibold hover:bg-black/35 disabled:opacity-50">
            Switch car
          </button>
        </header>

        <div className="border-b border-black bg-steel-950 px-3 py-2.5">
          <button
            type="button"
            disabled={busy !== null || !build}
            onClick={() => void engine.enterDrive()}
            className="flex h-11 w-full items-center justify-center gap-2 rounded bg-lift-500 px-3 text-[14px] font-extrabold uppercase tracking-[0.03em] text-steel-950 shadow-[inset_0_1px_0_rgb(255_255_255/0.55),0_6px_14px_rgb(0_0_0/0.4)] transition-colors hover:bg-lift-400 disabled:cursor-not-allowed disabled:opacity-45"
          >
            <CarFront size={18} strokeWidth={2.3} />
            {busy === 'entering-drive' ? 'Opening world...' : 'Drive in Open World'}
          </button>
        </div>

        <div className="flex items-center justify-between gap-2 border-b border-black bg-steel-950 px-3.5 py-2">
          <div className="flex min-w-0 items-center gap-2 text-xs">
            <span className={`h-2 w-2 flex-none rounded-full ${isModified ? 'bg-lift-500' : 'bg-steel-500'}`} />
            <span className={isModified ? 'font-semibold text-alu-200' : 'text-alu-500'}>
              {changeCount > 0 ? `${changeCount} ${changeCount === 1 ? 'change' : 'changes'} from stock` : isModified ? 'Custom build saved' : 'Stock build'}
            </span>
          </div>
          <button
            type="button"
            disabled={busy !== null || !isModified}
            onClick={() => engine.resetBuild()}
            className={`inline-flex h-7 flex-none items-center gap-1.5 rounded border px-2.5 text-xs font-semibold transition-colors disabled:cursor-default disabled:opacity-40 ${
              isModified
                ? 'border-lift-500/80 bg-lift-500/15 text-lift-500 hover:bg-lift-500 hover:text-steel-950'
                : 'border-steel-700 bg-steel-900 text-alu-500'
            }`}
          >
            <RotateCcw size={12} />
            Reset to stock
          </button>
        </div>

        {/* `relative` keeps the visually hidden inputs inside this scroller, so focusing one cannot scroll the page. */}
        <div className={`scroll-steel relative flex min-h-0 flex-1 flex-col gap-1.5 overflow-y-auto p-1.5 pb-6 ${busy ? 'pointer-events-none opacity-60' : ''}`}>
          <Drawer id="paint" open={open === 'paint'} name="Paint & finish" summary={summaries.paint} onToggle={() => toggle('paint')}>
            <PaintDrawer />
          </Drawer>
          <Drawer id="aero" open={open === 'aero'} name="Aero & exterior" summary={summaries.aero} onToggle={() => toggle('aero')}>
            <AeroDrawer />
          </Drawer>
          <Drawer id="wheels" open={open === 'wheels'} name="Wheels, brakes & stance" summary={summaries.wheels} onToggle={() => toggle('wheels')}>
            <WheelsDrawer />
          </Drawer>
          <Drawer id="shop" open={open === 'shop'} name="Shop tools" summary={summaries.shop} onToggle={() => toggle('shop')}>
            <ShopDrawer onOpenGuide={onOpenGuide} />
          </Drawer>
        </div>
      </aside>
    </div>
  );
}
