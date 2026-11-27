import { useMemo } from 'react';
import type { PartInfo, UniversalRoofAccessory, UniversalSpoilerStyle } from '@blend-garage/vehicle-core';
import { Note, Pill, PillRow, Section, TextButton, ToggleRow } from '../controls';
import { useEngine, useGarage } from '../engine';
import { tidyLabel } from '../format';

const SPOILERS: { id: UniversalSpoilerStyle; label: string }[] = [
  { id: 'stock', label: 'Stock' },
  { id: 'none', label: 'Delete' },
  { id: 'gt-wing', label: 'GT wing' },
  { id: 'ducktail', label: 'Ducktail' },
  { id: 'street-lip', label: 'Street lip' },
];

const ROOF_GEAR: { id: UniversalRoofAccessory; label: string }[] = [
  { id: 'none', label: 'Clean' },
  { id: 'roof-box', label: 'Touring roof box' },
  { id: 'rally-lightbar', label: 'Rally lightbar' },
];

const CATEGORY_NAME: Record<string, string> = {
  bumper: 'Bumpers',
  hood: 'Hood',
  fender: 'Fenders',
  door: 'Doors',
  spoiler: 'Spoiler',
  aero: 'Aero',
  exhaust: 'Exhaust',
  mirror: 'Mirrors',
  roof: 'Roof',
};

/** Bolt-on aero and accessories that fit any car, plus switches for the car's own detected panels. */
export function AeroDrawer() {
  const engine = useEngine();
  const manifest = useGarage((s) => s.manifest);
  const rig = useGarage((s) => s.rig);
  const build = useGarage((s) => s.build);

  const groups = useMemo(() => {
    const byCategory = new Map<string, PartInfo[]>();
    for (const part of manifest?.parts ?? []) {
      const list = byCategory.get(part.category);
      if (list) list.push(part);
      else byCategory.set(part.category, [part]);
    }
    return [...byCategory.entries()];
  }, [manifest]);

  if (!manifest || !rig || !build) return null;
  const parts = build.universalParts;
  const hidden = Object.values(build.partVisibility).filter((visible) => !visible).length;

  return (
    <>
      <Section title="Rear spoiler">
        <PillRow>
          {SPOILERS.map(({ id, label }) => (
            <Pill key={id} active={parts.spoiler === id} onClick={() => engine.setUniversalParts({ spoiler: id })}>
              {label}
            </Pill>
          ))}
        </PillRow>
        <Note>
          {rig.stockSpoilerParts > 0
            ? 'Anything but Stock takes the car’s own wing off first.'
            : 'No separate wing was found on this car, so Stock and Delete look the same.'}
        </Note>
      </Section>

      <Section title="Roof gear">
        <PillRow>
          {ROOF_GEAR.map(({ id, label }) => (
            <Pill key={id} active={parts.roof === id} onClick={() => engine.setUniversalParts({ roof: id })}>
              {label}
            </Pill>
          ))}
        </PillRow>
        {parts.roof === 'rally-lightbar' ? <Note>The lightbar comes on with the headlights (Shop tools drawer).</Note> : null}
      </Section>

      <Section title="Bolt-ons">
        <ToggleRow label="Front splitter" hint="Carbon blade under the nose" checked={parts.frontSplitter} onChange={(on) => engine.setUniversalParts({ frontSplitter: on })} />
        <ToggleRow label="Tow hook" hint="Red track-day ring on the front bumper" checked={parts.towHook} onChange={(on) => engine.setUniversalParts({ towHook: on })} />
        <ToggleRow label="Exhaust tips" hint="Polished quad tips at the tail" checked={parts.exhaustTips} onChange={(on) => engine.setUniversalParts({ exhaustTips: on })} />
      </Section>

      <Section title={`Stock panels (${manifest.parts.length})`} aside={hidden ? `${hidden} removed` : 'all fitted'}>
        {manifest.parts.length === 0 ? (
          <Note>
            No removable panels were found on this model. Name objects with a <code>part_</code> prefix in Blender to get switches here.
          </Note>
        ) : (
          <>
            <div className="mb-2 flex gap-1.5">
              <TextButton onClick={() => engine.setAllPartsVisible(true)} disabled={hidden === 0}>
                Fit all
              </TextButton>
              <TextButton onClick={() => engine.setAllPartsVisible(false)} disabled={hidden === manifest.parts.length}>
                Remove all
              </TextButton>
            </div>
            {groups.map(([category, list]) => (
              <div key={category} className="mb-2 last:mb-0">
                <p className="mb-0.5 text-xs font-semibold text-alu-400">{CATEGORY_NAME[category] ?? tidyLabel(category)}</p>
                {list.map((part) => (
                  <ToggleRow key={part.id} label={tidyLabel(part.objectName)} checked={build.partVisibility[part.id] !== false} onChange={(on) => engine.setPartVisible(part.id, on)} />
                ))}
              </div>
            ))}
          </>
        )}
      </Section>
    </>
  );
}
