import { useEffect, useRef, useState } from 'react';
import { Download, RefreshCw, RotateCcw, Upload } from 'lucide-react';
import { LIGHTING_MOODS } from '../../engine/types';
import { Note, Pill, PillRow, Section, Slider, TextButton, ToggleRow } from '../controls';
import { useEngine, useGarage } from '../engine';
import { formatClock, formatMeters } from '../format';

const LIFT_STOPS = [
  { label: 'Floor', height: 0 },
  { label: 'Wheels free', height: 0.45 },
  { label: 'Waist', height: 1.05 },
  { label: 'Full', height: 1.85 },
];

function download(fileName: string, text: string): void {
  const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = fileName;
  link.click();
  URL.revokeObjectURL(url);
}

function BuildSection() {
  const engine = useEngine();
  const build = useGarage((s) => s.build);
  const savedAt = useGarage((s) => s.savedAt);
  const fileRef = useRef<HTMLInputElement>(null);
  const [name, setName] = useState(build?.buildName ?? '');
  const [importError, setImportError] = useState<string | null>(null);
  const [confirmReset, setConfirmReset] = useState(false);

  useEffect(() => setName(build?.buildName ?? ''), [build?.buildName]);
  useEffect(() => {
    if (!confirmReset) return;
    const timer = setTimeout(() => setConfirmReset(false), 4000);
    return () => clearTimeout(timer);
  }, [confirmReset]);

  if (!build) return null;

  const onFile = async (file: File | undefined) => {
    if (!file) return;
    setImportError(engine.importBuild(await file.text()));
    if (fileRef.current) fileRef.current.value = '';
  };

  return (
    <Section title="This build" aside={savedAt ? `saved ${formatClock(savedAt)}` : 'stock, nothing to save yet'}>
      <label className="relative block text-[13px]">
        <span className="sr-only">Build name</span>
        <input
          type="text"
          value={name}
          maxLength={80}
          onChange={(event) => setName(event.target.value)}
          onBlur={() => (name.trim() ? engine.renameBuild(name) : setName(build.buildName))}
          onKeyDown={(event) => event.key === 'Enter' && event.currentTarget.blur()}
          className="h-[34px] w-full select-text rounded border border-steel-500 bg-steel-950 px-2.5 text-[13px] text-alu-200"
        />
      </label>
      <div className="mt-2 flex flex-wrap gap-1.5">
        <TextButton
          onClick={() => {
            const file = engine.exportBuild();
            if (file) download(file.fileName, file.json);
          }}
        >
          <Download size={13} />
          Export build
        </TextButton>
        <TextButton onClick={() => fileRef.current?.click()}>
          <Upload size={13} />
          Import build
        </TextButton>
        {confirmReset ? (
          <TextButton
            tone="danger"
            onClick={() => {
              engine.resetBuild();
              setConfirmReset(false);
            }}
          >
            Yes, reset this car
          </TextButton>
        ) : (
          <TextButton onClick={() => setConfirmReset(true)}>
            <RotateCcw size={13} />
            Reset to stock
          </TextButton>
        )}
        <input ref={fileRef} type="file" accept="application/json,.json" className="hidden" onChange={(event) => void onFile(event.target.files?.[0])} />
      </div>
      {importError ? (
        <p role="alert" className="mt-2 select-text rounded border border-chest-500 px-2.5 py-2 text-xs leading-snug text-alu-200">
          {importError}
        </p>
      ) : null}
      <Note>Builds save in this browser by themselves, one per car. Export a build to keep it or share it.</Note>
    </Section>
  );
}

/** Lift, lighting, the car's lights, and everything about saving builds and adding cars. */
export function ShopDrawer({ onOpenGuide }: { onOpenGuide: () => void }) {
  const engine = useEngine();
  const lift = useGarage((s) => s.lift);
  const mood = useGarage((s) => s.mood);
  const rig = useGarage((s) => s.rig);
  const lightsOn = useGarage((s) => s.build?.lightsOn ?? false);
  const catalogStatus = useGarage((s) => s.catalogStatus);
  const carCount = useGarage((s) => s.cars.length);

  return (
    <>
      <Section title="Hydraulic lift" aside={lift.moving ? 'moving' : lift.height < 0.01 ? 'on the floor' : 'holding'}>
        <Slider label="Lift height" value={lift.target} min={0} max={lift.max} step={0.01} display={formatMeters(lift.height)} onChange={(v) => engine.setLiftTarget(v)} />
        <div className="mt-2">
          <PillRow>
            {LIFT_STOPS.map(({ label, height }) => (
              <Pill key={label} active={Math.abs(lift.target - height) < 0.005} onClick={() => engine.setLiftTarget(height)}>
                {label}
              </Pill>
            ))}
          </PillRow>
        </div>
        <Note>Raise it past waist height and the Underside camera angle, or Walk mode, takes you under the car.</Note>
      </Section>

      <Section title="Shop lighting">
        <div className="grid grid-cols-2 gap-1.5">
          {LIGHTING_MOODS.map(({ id, label, blurb }) => (
            <button
              key={id}
              type="button"
              aria-pressed={mood === id}
              onClick={() => engine.setMood(id)}
              className={`rounded border px-2.5 py-2 text-left transition-colors ${mood === id ? 'border-lift-500 bg-lift-500 text-steel-950' : 'border-steel-500 bg-steel-700 hover:border-alu-500'}`}
            >
              <span className={`block text-[13px] font-bold leading-tight ${mood === id ? '' : 'text-white'}`}>{label}</span>
              <span className={`mt-0.5 block text-[11px] leading-tight ${mood === id ? 'text-steel-800' : 'text-alu-500'}`}>{blurb}</span>
            </button>
          ))}
        </div>
      </Section>

      <Section title="Car lights">
        <ToggleRow label="Headlights and taillights" checked={lightsOn} onChange={(on) => engine.setLights(on)} />
        {rig && !rig.hasHeadlights && !rig.hasTaillights ? (
          <Note>
            No lamp materials could be told apart on this model, so only the glow and beams are added. Name them <code>mat_headlight</code> and <code>mat_taillight</code> in Blender to light the lamps themselves.
          </Note>
        ) : null}
      </Section>

      <BuildSection />

      <Section title="Garage" aside={`${carCount} ${carCount === 1 ? 'car' : 'cars'}`}>
        <div className="flex flex-wrap gap-1.5">
          <TextButton onClick={() => void engine.refreshCatalog()} disabled={catalogStatus === 'loading'}>
            <RefreshCw size={13} className={catalogStatus === 'loading' ? 'animate-spin' : undefined} />
            Refresh car list
          </TextButton>
          <TextButton onClick={onOpenGuide}>How to add a .blend</TextButton>
          <TextButton onClick={() => void engine.leaveShop()}>Switch car</TextButton>
        </div>
      </Section>
    </>
  );
}
