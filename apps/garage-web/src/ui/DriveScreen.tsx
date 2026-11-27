import { memo, useState } from 'react';
import { AlertTriangle, ArrowLeft, Camera, ChevronDown, ChevronUp, Gamepad2, Keyboard, Lightbulb, MapPin, RotateCcw, Volume2, VolumeX, Wrench } from 'lucide-react';
import { DRIVE_CAMERA_VIEWS, type DriveCameraView } from '../engine/types';
import { useEngine, useGarage } from './engine';
import { formatTriangles } from './format';

const WARP_SPOTS = [
  { id: 'start', label: 'Garage Plaza' },
  { id: 'highway', label: 'Highway' },
  { id: 'canyon', label: 'Canyon Pass' },
  { id: 'proving-grounds', label: 'Crash Proving Grounds' },
] as const;

const WHEEL_LABELS = ['FL', 'FR', 'RL', 'RR'] as const;
const RPM_SEGMENTS = 24;
const REDLINE_START = 0.84;

function integrityColor(value: number): string {
  if (value >= 0.72) return 'bg-emerald-400';
  if (value >= 0.4) return 'bg-lift-500';
  return 'bg-chest-400';
}

function integrityText(value: number): string {
  if (value >= 0.72) return 'text-emerald-300';
  if (value >= 0.4) return 'text-lift-400';
  return 'text-chest-400';
}

function formatGear(gear: number): string {
  if (gear < 0) return 'R';
  if (gear === 0) return 'N';
  return String(gear);
}

function HealthBar({ label, value }: { label: string; value: number }) {
  const pct = Math.round(Math.max(0, Math.min(1, value)) * 100);
  return (
    <div>
      <div className="mb-0.5 flex items-center justify-between text-[11px]">
        <span className="font-semibold uppercase tracking-[0.04em] text-alu-400">{label}</span>
        <span className={`tabular font-bold ${integrityText(value)}`}>{pct}%</span>
      </div>
      <div className="h-1.5 overflow-hidden rounded-full bg-black/60">
        <div className={`h-full rounded-full transition-[width,background-color] duration-150 ${integrityColor(value)}`} style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

const PerfPill = memo(function PerfPill() {
  const perf = useGarage((s) => s.perf);
  if (perf.fps === 0) return null;
  return (
    <div className="tabular flex w-max gap-3.5 rounded bg-steel-900/90 px-3 py-1.5 text-xs text-alu-300 shadow-[0_6px_18px_rgb(0_0_0/0.35)]">
      <span>
        <b className="font-bold text-white">{perf.fps}</b> fps
      </span>
      <span>
        <b className="font-bold text-white">{perf.drawCalls}</b> draw calls
      </span>
      <span>
        <b className="font-bold text-white">{formatTriangles(perf.triangles)}</b> tris
      </span>
    </div>
  );
});

const TopLeftBar = memo(function TopLeftBar({
  carModel,
  spawnName,
  cameraView,
  busy,
}: {
  carModel: string | null;
  spawnName: string;
  cameraView: DriveCameraView;
  busy: boolean;
}) {
  const engine = useEngine();
  const cameraLabel = DRIVE_CAMERA_VIEWS.find((v) => v.id === cameraView)?.label ?? cameraView;

  return (
    <div className="pointer-events-auto absolute left-5 top-4 flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2">
        <PerfPill />
        {carModel ? (
          <div className="rounded bg-steel-900/90 px-3 py-1.5 text-xs text-alu-300 shadow-[0_6px_18px_rgb(0_0_0/0.35)]">
            <span className="font-badge font-extrabold uppercase text-white">{carModel}</span>
          </div>
        ) : null}
      </div>

      <div className="flex flex-wrap items-center gap-1.5">
        <div className="flex items-center gap-0.5 rounded-md border border-white/10 bg-steel-900/95 p-[3px] shadow-[0_8px_20px_rgb(0_0_0/0.4)]" role="group" aria-label="Quick warp locations">
          <span className="flex items-center px-1.5 text-alu-500" aria-hidden>
            <MapPin size={13} />
          </span>
          {WARP_SPOTS.map(({ id, label }) => {
            const active = spawnName === id;
            return (
              <button
                key={id}
                type="button"
                disabled={busy}
                aria-pressed={active}
                onClick={() => engine.resetDriveCar(id)}
                className={`h-7 rounded px-2.5 text-xs font-semibold transition-colors disabled:opacity-40 ${
                  active ? 'bg-lift-500 font-bold text-steel-950' : 'text-alu-300 hover:bg-white/10 hover:text-white'
                }`}
              >
                {label}
              </button>
            );
          })}
        </div>

        <button
          type="button"
          disabled={busy}
          onClick={() => engine.cycleDriveCamera()}
          className="inline-flex h-[34px] items-center gap-1.5 rounded-md border border-white/10 bg-steel-900/95 px-2.5 text-xs font-semibold text-alu-200 shadow-[0_8px_20px_rgb(0_0_0/0.4)] transition-colors hover:bg-steel-800 hover:text-white disabled:opacity-40"
        >
          <Camera size={13} className="text-lift-500" />
          <span>{cameraLabel}</span>
          <kbd className="rounded bg-black/50 px-1.5 py-0.5 font-mono text-[10px] text-alu-400">C</kbd>
        </button>
      </div>
    </div>
  );
});

const TopRightBar = memo(function TopRightBar({ isDamaged, busy }: { isDamaged: boolean; busy: boolean }) {
  const engine = useEngine();
  const audio = useGarage((s) => s.audio);
  const [controlsOpen, setControlsOpen] = useState(false);
  const [volumeOpen, setVolumeOpen] = useState(false);

  return (
    <div className="pointer-events-auto absolute right-5 top-4 flex flex-col items-end gap-2">
      <div className="flex flex-wrap items-center justify-end gap-1.5">
        <div
          className={`inline-flex h-9 items-center gap-1.5 rounded-md border px-2 text-xs font-semibold shadow-[0_8px_20px_rgb(0_0_0/0.4)] transition-colors ${
            audio.muted
              ? 'border-chest-500/60 bg-steel-900/95 text-chest-400'
              : 'border-white/15 bg-steel-900/95 text-alu-200'
          }`}
          onMouseEnter={() => setVolumeOpen(true)}
          onMouseLeave={() => setVolumeOpen(false)}
        >
          <button
            type="button"
            aria-label={audio.muted ? 'Unmute audio' : 'Mute audio'}
            aria-pressed={audio.muted}
            onClick={() => engine.toggleMute()}
            className="flex h-6 w-6 items-center justify-center rounded hover:bg-white/10"
          >
            {audio.muted ? <VolumeX size={14} /> : <Volume2 size={14} className="text-lift-500" />}
          </button>
          {volumeOpen ? (
            <label className="flex items-center gap-1.5 pr-1">
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
                className="slider w-16"
                style={{ ['--fill' as string]: `${Math.round((audio.muted ? 0 : audio.volume) * 100)}%` }}
              />
              <span className="tabular w-7 text-right text-[10px] font-semibold text-alu-300">{Math.round((audio.muted ? 0 : audio.volume) * 100)}%</span>
            </label>
          ) : (
            <kbd className="rounded bg-black/50 px-1 py-0.5 font-mono text-[10px] text-alu-400">M</kbd>
          )}
        </div>

        <button
          type="button"
          disabled={busy}
          onClick={() => engine.repairDriveCar()}
          className={`inline-flex h-9 items-center gap-1.5 rounded-md border px-3 text-xs font-bold shadow-[0_8px_20px_rgb(0_0_0/0.4)] transition-colors disabled:opacity-40 ${
            isDamaged
              ? 'border-lift-400 bg-lift-500 text-steel-950 hover:bg-lift-400'
              : 'border-white/15 bg-steel-900/95 text-alu-200 hover:bg-steel-800 hover:text-white'
          }`}
        >
          <Wrench size={13} />
          <span>Repair Car</span>
          <kbd className={`rounded px-1.5 py-0.5 font-mono text-[10px] ${isDamaged ? 'bg-black/20 text-steel-950' : 'bg-black/50 text-alu-400'}`}>R</kbd>
        </button>

        <button
          type="button"
          disabled={busy}
          onClick={() => engine.resetDriveCar()}
          className="inline-flex h-9 items-center gap-1.5 rounded-md border border-white/15 bg-steel-900/95 px-3 text-xs font-semibold text-alu-200 shadow-[0_8px_20px_rgb(0_0_0/0.4)] transition-colors hover:bg-steel-800 hover:text-white disabled:opacity-40"
        >
          <RotateCcw size={13} />
          <span>Reset to Road</span>
          <kbd className="rounded bg-black/50 px-1.5 py-0.5 font-mono text-[10px] text-alu-400">T</kbd>
        </button>

        <button
          type="button"
          disabled={busy}
          onClick={() => void engine.exitDrive()}
          className="inline-flex h-9 items-center gap-1.5 rounded-md border border-chest-400/70 bg-chest-700/95 px-3 text-xs font-bold text-white shadow-[0_8px_20px_rgb(0_0_0/0.45)] transition-colors hover:bg-chest-500 disabled:opacity-40"
        >
          <ArrowLeft size={14} />
          <span>Back to Shop</span>
          <kbd className="rounded bg-black/35 px-1.5 py-0.5 font-mono text-[10px] text-white/85">Esc</kbd>
        </button>
      </div>

      <div className="flex flex-col items-end">
        <button
          type="button"
          aria-expanded={controlsOpen}
          onClick={() => setControlsOpen((v) => !v)}
          className="inline-flex h-7 items-center gap-1.5 rounded border border-white/10 bg-steel-900/92 px-2.5 text-[11px] font-semibold text-alu-300 hover:bg-steel-800 hover:text-white"
        >
          <span>Controls</span>
          {controlsOpen ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
        </button>

        {controlsOpen ? (
          <div className="mt-1.5 w-[300px] rounded-md border border-white/10 bg-steel-900/96 p-3 text-[11px] text-alu-300 shadow-[0_14px_30px_rgb(0_0_0/0.55)]">
            <div className="grid grid-cols-2 gap-3">
              <div>
                <p className="mb-1.5 flex items-center gap-1 font-bold uppercase tracking-[0.06em] text-lift-500">
                  <Keyboard size={12} /> Keyboard
                </p>
                <ul className="space-y-1 text-alu-300">
                  <li className="flex justify-between gap-2"><span>Drive</span><kbd className="font-mono text-white">WASD / ↑↓←→</kbd></li>
                  <li className="flex justify-between gap-2"><span>Handbrake</span><kbd className="font-mono text-white">Space</kbd></li>
                  <li className="flex justify-between gap-2"><span>Shift</span><kbd className="font-mono text-white">Q / E</kbd></li>
                  <li className="flex justify-between gap-2"><span>Horn / Lights</span><kbd className="font-mono text-white">H / L</kbd></li>
                  <li className="flex justify-between gap-2"><span>Camera / Mute</span><kbd className="font-mono text-white">C / M</kbd></li>
                  <li className="flex justify-between gap-2"><span>Repair / Reset</span><kbd className="font-mono text-white">R / T</kbd></li>
                  <li className="flex justify-between gap-2"><span>Back to Shop</span><kbd className="font-mono text-white">Esc</kbd></li>
                </ul>
              </div>
              <div>
                <p className="mb-1.5 flex items-center gap-1 font-bold uppercase tracking-[0.06em] text-lift-500">
                  <Gamepad2 size={12} /> Controller
                </p>
                <ul className="space-y-1 text-alu-300">
                  <li className="flex justify-between gap-2"><span>Steer</span><kbd className="font-mono text-white">L-Stick</kbd></li>
                  <li className="flex justify-between gap-2"><span>Gas / Brake</span><kbd className="font-mono text-white">RT / LT</kbd></li>
                  <li className="flex justify-between gap-2"><span>Handbrake</span><kbd className="font-mono text-white">A / B</kbd></li>
                  <li className="flex justify-between gap-2"><span>Shift</span><kbd className="font-mono text-white">LB / RB</kbd></li>
                  <li className="flex justify-between gap-2"><span>Horn / Lights</span><kbd className="font-mono text-white">R3 / D-Pad</kbd></li>
                  <li className="flex justify-between gap-2"><span>Camera</span><kbd className="font-mono text-white">Y / △</kbd></li>
                  <li className="flex justify-between gap-2"><span>Repair / Shop</span><kbd className="font-mono text-white">Back / Start</kbd></li>
                </ul>
              </div>
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
});

const VehicleDiagnostics = memo(function VehicleDiagnostics() {
  const engine = useEngine();
  const drive = useGarage((s) => s.drive);
  if (!drive) return null;

  const { health } = drive;
  const steerPullPct = Math.round(Math.abs(health.steeringPull) * 100);
  const steerPullDir = health.steeringPull > 0.08 ? 'Pulls Left' : health.steeringPull < -0.08 ? 'Pulls Right' : null;

  return (
    <div className="pointer-events-auto absolute bottom-5 left-5 flex flex-col gap-2">
      <div className="w-[248px] rounded-md border border-white/10 bg-steel-900/94 p-3 shadow-[0_12px_28px_rgb(0_0_0/0.5)]">
        <div className="mb-2 flex items-center justify-between">
          <span className="font-narrow text-xs font-bold uppercase tracking-[0.06em] text-white">Vehicle Diagnostics</span>
          {drive.totalImpacts > 0 ? (
            <span className="tabular rounded bg-chest-700/85 px-1.5 py-0.5 text-[10px] font-bold text-white">
              {drive.lastImpactG > 0.1 ? `${drive.lastImpactG.toFixed(1)}G · ` : ''}
              {drive.totalImpacts} {drive.totalImpacts === 1 ? 'hit' : 'hits'}
            </span>
          ) : (
            <span className="text-[10px] font-semibold uppercase tracking-[0.05em] text-emerald-400">Mint</span>
          )}
        </div>

        <div className="grid gap-1.5">
          <HealthBar label="Chassis" value={health.chassisIntegrity} />
          <HealthBar label="Engine" value={health.engineHealth} />
        </div>

        <div className="mt-2.5 grid grid-cols-4 gap-1.5">
          {WHEEL_LABELS.map((label, index) => {
            const val = health.wheelIntegrity[index] ?? 1;
            const pct = Math.round(Math.max(0, Math.min(1, val)) * 100);
            return (
              <div key={label} className="rounded bg-black/50 px-1.5 py-1 text-center">
                <div className="flex items-center justify-between text-[10px]">
                  <span className="font-bold text-alu-400">{label}</span>
                  <span className={`tabular font-bold ${integrityText(val)}`}>{pct}</span>
                </div>
                <div className="mt-1 h-1 overflow-hidden rounded-full bg-steel-800">
                  <div className={`h-full rounded-full ${integrityColor(val)}`} style={{ width: `${pct}%` }} />
                </div>
              </div>
            );
          })}
        </div>

        <div className="mt-2.5 flex flex-wrap items-center justify-between gap-1.5 border-t border-white/10 pt-2 text-[10px]">
          <div className="flex items-center gap-1.5">
            <button
              type="button"
              onClick={() => engine.toggleDriveLights()}
              className={`inline-flex items-center gap-1 rounded px-1.5 py-0.5 font-bold transition-colors ${
                !health.headlightsIntact
                  ? 'bg-chest-700/80 text-white'
                  : drive.lightsOn
                    ? 'bg-lift-500 text-steel-950'
                    : 'bg-steel-800 text-alu-300 hover:bg-steel-700'
              }`}
            >
              <Lightbulb size={10} />
              {health.headlightsIntact ? (drive.lightsOn ? 'HEAD ON' : 'HEAD OFF') : 'HEAD OUT'}
            </button>
            <span className={`rounded px-1.5 py-0.5 font-bold ${health.taillightsIntact ? 'bg-steel-800 text-alu-300' : 'bg-chest-700/80 text-white'}`}>
              {health.taillightsIntact ? 'TAIL OK' : 'TAIL OUT'}
            </span>
          </div>

          {steerPullDir ? (
            <span className="inline-flex items-center gap-1 rounded bg-lift-500/20 px-1.5 py-0.5 font-bold text-lift-400">
              <AlertTriangle size={10} />
              {steerPullDir} ({steerPullPct}%)
            </span>
          ) : null}
        </div>
      </div>

      <div className="flex w-max max-w-[300px] items-center gap-2 rounded-md border border-white/10 bg-steel-900/92 px-2.5 py-1.5 text-xs text-alu-200 shadow-[0_6px_16px_rgb(0_0_0/0.4)]">
        {drive.inputSource === 'gamepad' ? <Gamepad2 size={14} className="flex-none text-lift-500" /> : <Keyboard size={14} className="flex-none text-lift-500" />}
        <span className="truncate font-semibold">
          {drive.inputSource === 'gamepad' ? `Controller: ${drive.gamepadName ?? 'Gamepad'}` : 'Keyboard (WASD / Arrows)'}
        </span>
      </div>
    </div>
  );
});

const SpeedCluster = memo(function SpeedCluster() {
  const drive = useGarage((s) => s.drive);
  if (!drive) return null;

  const rpmRatio = Math.max(0, Math.min(1, drive.maxRpm > 0 ? drive.rpm / drive.maxRpm : 0));
  const isRedline = rpmRatio >= REDLINE_START;

  return (
    <div className="pointer-events-none absolute bottom-5 right-5 w-[276px] rounded-md border border-white/10 bg-steel-900/94 p-3.5 shadow-[0_12px_28px_rgb(0_0_0/0.55)]">
      <div className="flex items-end justify-between gap-3">
        <div>
          <div className="flex items-baseline gap-1.5">
            <span className="font-badge tabular text-[44px] font-black leading-none tracking-tight text-white">{Math.round(drive.speedMph)}</span>
            <span className="font-narrow text-xs font-bold uppercase tracking-[0.06em] text-alu-400">MPH</span>
          </div>
          <p className="tabular mt-0.5 text-xs font-semibold text-alu-400">{Math.round(drive.speedKmh)} km/h</p>
        </div>

        <div className="flex flex-col items-end gap-1.5">
          {drive.handbrake ? (
            <span className="rounded bg-chest-500 px-2 py-0.5 text-[10px] font-extrabold uppercase tracking-[0.08em] text-white">HANDBRAKE</span>
          ) : drive.hornActive ? (
            <span className="rounded bg-lift-500 px-2 py-0.5 text-[10px] font-extrabold uppercase tracking-[0.08em] text-steel-950">HORN</span>
          ) : (
            <span className="h-[18px]" />
          )}
          <div className="flex h-12 w-12 items-center justify-center rounded border border-lift-500/70 bg-steel-950 shadow-[inset_0_2px_6px_rgb(0_0_0/0.8)]">
            <span className={`font-badge text-2xl font-black ${drive.gear < 0 ? 'text-chest-400' : 'text-lift-500'}`}>{formatGear(drive.gear)}</span>
          </div>
        </div>
      </div>

      <div className="mt-3">
        <div className="mb-1 flex items-center justify-between text-[10px]">
          <span className="font-bold uppercase tracking-[0.06em] text-alu-400">RPM</span>
          <span className={`tabular font-bold ${isRedline ? 'text-chest-400' : 'text-alu-200'}`}>
            {Math.round(drive.rpm).toLocaleString()} / {Math.round(drive.maxRpm).toLocaleString()}
          </span>
        </div>
        <div className="grid grid-cols-24 gap-[2px]">
          {Array.from({ length: RPM_SEGMENTS }, (_, i) => {
            const frac = (i + 1) / RPM_SEGMENTS;
            const lit = rpmRatio >= i / RPM_SEGMENTS && drive.rpm > 100;
            const zoneColor = frac >= REDLINE_START ? 'bg-chest-400' : frac >= 0.68 ? 'bg-lift-500' : 'bg-alu-200';
            return <span key={i} className={`h-2.5 rounded-[1px] ${lit ? zoneColor : 'bg-black/55'}`} />;
          })}
        </div>
      </div>

      <div className="mt-2.5 grid grid-cols-2 gap-2 text-[10px]">
        <div>
          <div className="mb-0.5 flex justify-between text-alu-400">
            <span>GAS</span>
            <span className="tabular">{Math.round(drive.throttle * 100)}%</span>
          </div>
          <div className="h-1.5 overflow-hidden rounded-full bg-black/60">
            <div className="h-full rounded-full bg-emerald-400" style={{ width: `${Math.round(drive.throttle * 100)}%` }} />
          </div>
        </div>
        <div>
          <div className="mb-0.5 flex justify-between text-alu-400">
            <span>BRAKE</span>
            <span className="tabular">{Math.round(drive.brake * 100)}%</span>
          </div>
          <div className="h-1.5 overflow-hidden rounded-full bg-black/60">
            <div className="h-full rounded-full bg-chest-400" style={{ width: `${Math.round(drive.brake * 100)}%` }} />
          </div>
        </div>
      </div>
    </div>
  );
});

/** Open-World Drive Mode HUD: split into focused sub-components with zero backdrop-blur GPU readbacks. */
export function DriveScreen() {
  const hasDrive = useGarage((s) => s.drive !== null);
  const carModel = useGarage((s) => s.cars.find((c) => c.id === s.selectedCarId)?.model ?? null);
  const spawnName = useGarage((s) => s.drive?.spawnName ?? 'start');
  const cameraView = useGarage((s) => s.drive?.cameraView ?? 'chase');
  const busy = useGarage((s) => s.busy !== null);
  const isDamaged = useGarage((s) => {
    const h = s.drive?.health;
    if (!h) return false;
    return (
      h.chassisIntegrity < 0.995 ||
      h.engineHealth < 0.995 ||
      !h.headlightsIntact ||
      !h.taillightsIntact ||
      h.wheelIntegrity.some((w) => w < 0.995)
    );
  });

  if (!hasDrive) return null;

  return (
    <div className="pointer-events-none absolute inset-0">
      <TopLeftBar carModel={carModel} spawnName={spawnName} cameraView={cameraView} busy={busy} />
      <TopRightBar isDamaged={isDamaged} busy={busy} />
      <VehicleDiagnostics />
      <SpeedCluster />
    </div>
  );
}
