import { Fragment, useEffect, useRef } from 'react';
import { RefreshCw } from 'lucide-react';
import type { CarLoadState, CatalogCar } from '../engine/types';
import { useEngine, useGarage } from './engine';
import { formatMeters, formatTriangles } from './format';

const PHASE_TEXT: Record<CarLoadState['phase'], string> = {
  manifest: 'Reading the car’s description',
  download: 'Downloading the model',
  decode: 'Unpacking the mesh',
  prepare: 'Merging meshes for the graphics card',
  ready: '',
  error: '',
};

function titleSize(model: string): string {
  if (model.length <= 12) return 'clamp(38px, 5.4vw, 84px)';
  if (model.length <= 20) return 'clamp(32px, 4.2vw, 64px)';
  return 'clamp(26px, 3.3vw, 50px)';
}

function KeyRail({ cars, selectedId, disabled }: { cars: CatalogCar[]; selectedId: string | null; disabled: boolean }) {
  const engine = useEngine();
  const railRef = useRef<HTMLElement>(null);

  // Keep the chosen tag in view when stepping with the arrow keys.
  useEffect(() => {
    railRef.current?.querySelector('[aria-current="true"]')?.scrollIntoView({ inline: 'center', block: 'nearest', behavior: 'smooth' });
  }, [selectedId]);

  return (
    <nav
      ref={railRef}
      aria-label="Cars in the garage"
      className="scroll-steel pointer-events-auto absolute inset-x-0 bottom-0 overflow-x-auto px-6 pb-5 pt-4"
      onWheel={(event) => {
        if (Math.abs(event.deltaY) > Math.abs(event.deltaX)) event.currentTarget.scrollLeft += event.deltaY;
      }}
    >
      {/* One wrapper as wide as the row of tags, so the rail runs the full length when the row scrolls. */}
      <div className="inline-block min-w-full align-top">
        <div className="metal-rail mx-2 h-2.5 rounded-full" />
        <ul className="-mt-0.5 flex gap-2.5 px-3.5">
          {cars.map((car) => (
            <li key={car.id}>
              <button type="button" className="key-tag" aria-current={car.id === selectedId} disabled={disabled} onClick={() => engine.selectCar(car.id)}>
                <span className="font-narrow block min-h-[44px] text-[13px] font-bold leading-[1.12]">{car.name}</span>
                <span className="tabular mt-1.5 block text-[11px] text-ink-soft">{car.manifest ? `${formatTriangles(car.manifest.triangleCount)} triangles` : ' '}</span>
              </button>
            </li>
          ))}
        </ul>
      </div>
    </nav>
  );
}

function PlateRow({ label, value }: { label: string; value: string }) {
  return (
    <>
      <dt className="border-t border-black/20 py-1.5">{label}</dt>
      <dd className="tabular border-t border-black/20 py-1.5 text-right font-bold">{value}</dd>
    </>
  );
}

/** The opening screen: browse the imported cars on the turntable, then roll one into the shop. */
export function SelectorScreen({ onOpenGuide }: { onOpenGuide: () => void }) {
  const engine = useEngine();
  const cars = useGarage((s) => s.cars);
  const selectedId = useGarage((s) => s.selectedCarId);
  const load = useGarage((s) => s.load);
  const rig = useGarage((s) => s.rig);
  const loaded = useGarage((s) => s.manifest);
  const busy = useGarage((s) => s.busy);
  const catalogStatus = useGarage((s) => s.catalogStatus);
  const catalogError = useGarage((s) => s.catalogError);

  const car = cars.find((c) => c.id === selectedId) ?? null;
  const manifest = loaded && loaded.id === selectedId ? loaded : (car?.manifest ?? null);
  const ready = load?.phase === 'ready' && loaded?.id === selectedId;
  const size = ready && rig ? rig.size : manifest?.bounds.size;

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const el = event.target as HTMLElement | null;
      if (el && /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName)) return;
      if (event.key === 'ArrowRight') engine.stepCar(1);
      else if (event.key === 'ArrowLeft') engine.stepCar(-1);
      else if (event.key === 'Enter' && el?.tagName !== 'BUTTON') void engine.enterShop();
      else return;
      event.preventDefault();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [engine]);

  if (catalogStatus === 'error') {
    return (
      <div className="absolute inset-0 grid place-items-center bg-steel-950/80 p-8">
        <div className="max-w-xl select-text">
          <h1 className="font-badge text-3xl font-extrabold text-white">The car list could not be loaded</h1>
          <p className="mt-3 text-lg leading-snug">{catalogError}</p>
          <button type="button" className="button-red mt-6 rounded-md px-5 py-3 text-base font-bold text-white" onClick={() => void engine.refreshCatalog()}>
            Try again
          </button>
        </div>
      </div>
    );
  }

  if (catalogStatus === 'ready' && cars.length === 0) {
    return (
      <div className="absolute inset-0 grid place-items-center p-8">
        <div className="max-w-xl select-text rounded-md bg-steel-900/85 p-8">
          <h1 className="font-badge text-3xl font-extrabold text-white">The garage is empty</h1>
          <p className="mt-3 text-lg leading-snug">
            Drop a <code>.blend</code> car file into <code>cars/incoming/</code>, run <code>npm run import-cars</code>, then refresh the list.
          </p>
          <div className="mt-6 flex gap-3">
            <button type="button" className="button-red rounded-md px-5 py-3 text-base font-bold text-white" onClick={() => void engine.refreshCatalog()}>
              Refresh car list
            </button>
            <button type="button" className="rounded-md border border-alu-500 px-5 py-3 text-base font-semibold text-white" onClick={onOpenGuide}>
              How to add a .blend
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="pointer-events-none absolute inset-0">
      <div className="font-badge absolute left-8 top-6 text-[15px] font-extrabold tracking-[0.02em] text-white">
        BLEND <span className="text-lift-500">GARAGE</span>
      </div>

      <div className="absolute left-8 top-[72px] max-w-[56vw] text-white">
        {car ? (
          <>
            <p className="text-[17px] font-medium text-alu-300">{car.make}</p>
            <h1 className="font-badge mt-0.5 font-extrabold uppercase leading-[0.98] tracking-[-0.01em]" style={{ fontSize: titleSize(car.model) }}>
              {/* Each word stays whole, so a code like LP700-4 never breaks at its hyphen. */}
              {car.model.split(' ').map((word, i) => (
                <Fragment key={i}>
                  <span className="whitespace-nowrap">{word}</span>{' '}
                </Fragment>
              ))}
            </h1>
          </>
        ) : (
          <h1 className="font-badge text-4xl font-extrabold">{catalogStatus === 'loading' ? 'Opening the garage' : 'Pick a car'}</h1>
        )}

        {load && load.phase !== 'ready' && load.phase !== 'error' ? (
          <div className="mt-5 w-72" role="status">
            <p className="text-sm text-alu-300">{PHASE_TEXT[load.phase]}</p>
            <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-black/50">
              <div className="h-full rounded-full bg-lift-500 transition-[width] duration-150" style={{ width: `${Math.round(load.progress * 100)}%` }} />
            </div>
          </div>
        ) : null}

        {load?.phase === 'error' ? (
          <div className="pointer-events-auto mt-5 max-w-md select-text rounded-md border border-chest-500 bg-steel-900/90 p-4" role="alert">
            <p className="font-semibold text-white">This car could not be loaded</p>
            <p className="mt-1 text-sm leading-snug text-alu-300">{load.error}</p>
            <button type="button" className="mt-3 rounded border border-alu-500 px-3 py-1.5 text-sm font-semibold text-white hover:bg-white/10" onClick={() => engine.retryLoad()}>
              Try again
            </button>
          </div>
        ) : null}
      </div>

      <aside className="pointer-events-auto absolute right-8 top-1/2 w-[292px] -translate-y-[58%]">
        <div className="metal-plate relative rounded-md px-[22px] pb-4 pt-5 text-ink">
          <span className="rivet absolute left-2 top-2 h-[7px] w-[7px] rounded-full" />
          <span className="rivet absolute right-2 top-2 h-[7px] w-[7px] rounded-full" />
          <h2 className="font-narrow mb-2.5 text-center text-xs font-bold uppercase tracking-[0.06em]">Vehicle data plate</h2>
          <dl className="grid grid-cols-[1fr_auto] text-sm">
            <PlateRow label="Length" value={size ? formatMeters(size[2]) : '–'} />
            <PlateRow label="Width" value={size ? formatMeters(size[0]) : '–'} />
            <PlateRow label="Height" value={size ? formatMeters(size[1]) : '–'} />
            <PlateRow label="Triangles" value={manifest ? formatTriangles(ready && rig ? rig.triangles : manifest.triangleCount) : '–'} />
            <PlateRow label="Wheels found" value={ready && rig ? String(rig.wheels.length) : manifest ? String(manifest.wheels.length) : '–'} />
            <PlateRow label="Stock panels" value={manifest ? String(manifest.parts.length) : '–'} />
            <PlateRow label="Materials" value={manifest ? String(manifest.materialZones.length) : '–'} />
          </dl>
          {manifest ? <p className="mt-2 truncate border-t border-black/20 pt-2 text-xs text-ink-soft">Imported from {manifest.sourceFile}</p> : null}
        </div>

        <button
          type="button"
          className="button-red mt-3.5 h-[54px] w-full rounded-md text-[17px] font-bold text-white transition-[filter] hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:brightness-100"
          disabled={!ready || busy !== null}
          onClick={() => void engine.enterShop()}
        >
          {busy === 'rolling-in' ? 'Rolling in' : 'Roll it into the shop'}
        </button>

        <div className="mt-3 flex items-center justify-between text-[13px]">
          <button type="button" className="inline-flex items-center gap-1.5 text-alu-300 underline-offset-2 hover:text-white hover:underline" onClick={() => void engine.refreshCatalog()}>
            <RefreshCw size={13} className={catalogStatus === 'loading' ? 'animate-spin' : undefined} />
            Refresh car list
          </button>
          <button type="button" className="text-alu-300 underline-offset-2 hover:text-white hover:underline" onClick={onOpenGuide}>
            Add a .blend
          </button>
        </div>
      </aside>

      <KeyRail cars={cars} selectedId={selectedId} disabled={busy !== null} />
    </div>
  );
}
