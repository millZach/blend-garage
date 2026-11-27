import { useState } from 'react';
import { RefreshCw } from 'lucide-react';
import { Modal } from './controls';
import { useEngine, useGarage } from './engine';

const CONVENTIONS: { what: string; name: string; unlocks: string }[] = [
  { what: 'Wheels', name: 'wheel_FL, wheel_FR, wheel_RL, wheel_RR', unlocks: 'Spin, steering, camber, spacers and wheel faces' },
  { what: 'Panels', name: 'part_hood, part_spoiler, part_door_FL …', unlocks: 'A switch per panel in Aero & exterior' },
  { what: 'Mounts', name: 'slot_spoiler, slot_roof, slot_exhaust (empties)', unlocks: 'Exact spots for bolt-on parts' },
  { what: 'Paint', name: 'mat_paint_primary, mat_paint_secondary, mat_paint_accent', unlocks: 'Body, second color and accent shortcuts' },
  { what: 'Rims and glass', name: 'mat_rim, mat_glass', unlocks: 'Rim finish and glass tint' },
  { what: 'Lamps', name: 'mat_headlight, mat_taillight', unlocks: 'Lamps that light up with the light switch' },
];

/** How to get another .blend car into the garage. */
export function BlendGuide({ onClose }: { onClose: () => void }) {
  const engine = useEngine();
  const count = useGarage((s) => s.cars.length);
  const status = useGarage((s) => s.catalogStatus);
  const [refreshed, setRefreshed] = useState(false);

  return (
    <Modal title="Add a car from a .blend file" onClose={onClose}>
      <ol className="list-decimal space-y-2.5 pl-5">
        <li>
          Put the <code className="rounded bg-black/10 px-1">.blend</code> file in <code className="rounded bg-black/10 px-1">cars/incoming/</code> at the top of the project.
        </li>
        <li>
          In a terminal there, run <code className="rounded bg-black/10 px-1">npm run import-cars</code>. Blender converts every file in the folder; a big car takes a minute or two.
          <span className="mt-1 block text-sm text-ink-soft">
            To import each time you save in Blender, leave <code className="rounded bg-black/10 px-1">npm run watch-cars</code> running instead.
          </span>
        </li>
        <li>
          Come back here and refresh the car list.
          <span className="mt-2 flex items-center gap-3">
            <button
              type="button"
              disabled={status === 'loading'}
              onClick={() => void engine.refreshCatalog().then(() => setRefreshed(true))}
              className="inline-flex items-center gap-2 rounded bg-ink px-3.5 py-2 text-sm font-bold text-white hover:bg-black disabled:opacity-50"
            >
              <RefreshCw size={14} className={status === 'loading' ? 'animate-spin' : undefined} />
              Refresh car list
            </button>
            {refreshed && status === 'ready' ? (
              <span className="text-sm text-ink-soft">
                {count} {count === 1 ? 'car' : 'cars'} in the garage now.
              </span>
            ) : null}
          </span>
        </li>
      </ol>

      <h3 className="mt-6 text-base font-bold">Names that unlock more</h3>
      <p className="mt-1 text-sm text-ink-soft">
        Any <code className="rounded bg-black/10 px-1">.blend</code> works as it is. The garage finds wheels by their shape and sorts materials by name on its own. Naming things this way in Blender makes it exact.
      </p>
      <table className="mt-3 w-full border-collapse text-left text-sm">
        <thead>
          <tr className="border-b-2 border-ink">
            <th className="py-1.5 pr-3 font-bold">For</th>
            <th className="py-1.5 pr-3 font-bold">Name it</th>
            <th className="py-1.5 font-bold">You get</th>
          </tr>
        </thead>
        <tbody>
          {CONVENTIONS.map((row) => (
            <tr key={row.what} className="border-b border-paper-dim align-top">
              <td className="py-1.5 pr-3 font-semibold">{row.what}</td>
              <td className="font-narrow py-1.5 pr-3">{row.name}</td>
              <td className="py-1.5">{row.unlocks}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </Modal>
  );
}
