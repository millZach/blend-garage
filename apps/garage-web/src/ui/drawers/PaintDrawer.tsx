import { useEffect, useMemo, useState } from 'react';
import { Crosshair, RotateCcw } from 'lucide-react';
import { AUTOMOTIVE_PAINT_PRESETS, FINISH_PROFILES, RIM_FINISH_PRESETS, type MaterialZoneInfo, type PaintFinishType, type PaintZoneRole, type PaintZoneState } from '@blend-garage/vehicle-core';
import { ColorDot, Note, PaintChip, Pill, PillRow, Section, Slider, TextButton } from '../controls';
import { useEngine, useGarage } from '../engine';

/** Roles offered as shortcuts, in the order a painter thinks about a car. */
const ROLE_SHORTCUTS: { role: PaintZoneRole; label: string; plural: string }[] = [
  { role: 'primary', label: 'Body', plural: 'body zones' },
  { role: 'secondary', label: 'Second color', plural: 'second-color zones' },
  { role: 'accent', label: 'Accent', plural: 'accent zones' },
  { role: 'rim', label: 'Rims', plural: 'rim zones' },
  { role: 'glass', label: 'Glass', plural: 'glass zones' },
  { role: 'trim', label: 'Trim', plural: 'trim zones' },
  { role: 'headlight', label: 'Headlights', plural: 'headlight zones' },
  { role: 'taillight', label: 'Taillights', plural: 'taillight zones' },
];

const ROLE_NAME: Record<PaintZoneRole, string> = {
  primary: 'Body',
  secondary: 'Second color',
  accent: 'Accent',
  rim: 'Rim',
  glass: 'Glass',
  trim: 'Trim',
  headlight: 'Headlight',
  taillight: 'Taillight',
  other: 'Other',
};

const FINISHES: { id: PaintFinishType; label: string }[] = [
  { id: 'gloss', label: 'Gloss' },
  { id: 'metallic', label: 'Metallic' },
  { id: 'satin', label: 'Satin' },
  { id: 'matte', label: 'Matte' },
  { id: 'pearlescent', label: 'Pearl' },
  { id: 'chrome', label: 'Chrome' },
];

const CALIPER_COLORS = [
  { name: 'Red', color: '#c81d25' },
  { name: 'Yellow', color: '#f2c214' },
  { name: 'Orange', color: '#f05a1a' },
  { name: 'Blue', color: '#1c4fa3' },
  { name: 'Lime', color: '#8fd41f' },
  { name: 'Black', color: '#16181c' },
];

const GLASS_TINTS = [
  { name: 'Smoke', color: '#1c2227' },
  { name: 'Bronze', color: '#3a2a1c' },
  { name: 'Blue', color: '#14263c' },
  { name: 'Green', color: '#16302a' },
];

const MAX_ROWS = 60;

function ZoneRow({ zone, role, state, selected, onSelect }: { zone: MaterialZoneInfo; role: PaintZoneRole; state: PaintZoneState | undefined; selected: boolean; onSelect: () => void }) {
  return (
    <li>
      <button
        type="button"
        onClick={onSelect}
        aria-current={selected}
        className={`flex w-full items-center gap-2 px-2 py-1.5 text-left text-[13px] ${selected ? 'bg-lift-500 text-steel-950' : 'hover:bg-steel-700'}`}
      >
        <span className="h-4 w-4 flex-none rounded-sm border border-black/40" style={{ backgroundColor: state?.color ?? zone.defaultColor }} />
        <span className="min-w-0 flex-1 truncate">{zone.materialName}</span>
        {state?.modified ? <span className={`flex-none text-[11px] font-semibold ${selected ? '' : 'text-lift-500'}`}>painted</span> : null}
        <span className={`flex-none text-[11px] ${selected ? 'text-steel-800' : 'text-alu-500'}`}>{ROLE_NAME[role]}</span>
      </button>
    </li>
  );
}

/** Paint and finish booth: pick a material zone, then give it a color, a finish and its PBR values. */
export function PaintDrawer() {
  const engine = useEngine();
  const manifest = useGarage((s) => s.manifest);
  const rig = useGarage((s) => s.rig);
  const build = useGarage((s) => s.build);
  const [zoneId, setZoneId] = useState<string | null>(null);
  const [query, setQuery] = useState('');

  const zones = useMemo(() => (manifest && rig ? manifest.materialZones.filter((z) => z.id in rig.zoneRoles) : []), [manifest, rig]);
  const selected = zones.find((z) => z.id === zoneId) ?? zones.find((z) => z.id === rig?.roleLeads.primary) ?? zones[0] ?? null;
  // The rig's role for a zone, which differs from the manifest's for the zone found to be the real body paint.
  const roleOf = (zone: MaterialZoneInfo): PaintZoneRole => rig?.zoneRoles[zone.id] ?? zone.role;
  const selectedRole = selected ? roleOf(selected) : 'other';

  // A different car has different zones.
  useEffect(() => {
    setZoneId(null);
    setQuery('');
  }, [manifest?.id]);

  const listed = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (q) return zones.filter((z) => z.materialName.toLowerCase().includes(q));
    // With no search, list the selected zone's own role, lead first.
    const ids = rig?.roleZones[selectedRole] ?? [];
    return ids.map((id) => zones.find((z) => z.id === id)).filter((z): z is MaterialZoneInfo => z !== undefined);
  }, [zones, query, rig, selectedRole]);

  if (!manifest || !rig || !build || !selected) return <Note>This car has no paintable materials.</Note>;

  const state = build.paintZones[selected.id];
  const siblings = rig.roleZones[selectedRole] ?? [];
  const select = (id: string) => {
    setZoneId(id);
    engine.flashZone(id);
  };
  const presets = selectedRole === 'rim' ? [...RIM_FINISH_PRESETS, ...AUTOMOTIVE_PAINT_PRESETS] : AUTOMOTIVE_PAINT_PRESETS;
  const caliperColor = rig.caliperZones.length ? build.paintZones[rig.caliperZones[0]] : undefined;
  const tint = build.glassTint;

  return (
    <>
      <Section title="Paint what" aside={`${zones.length} materials on this car`}>
        <PillRow>
          {ROLE_SHORTCUTS.filter(({ role }) => rig.roleLeads[role]).map(({ role, label }) => (
            <Pill key={role} active={selectedRole === role && !query} onClick={() => (setQuery(''), select(rig.roleLeads[role]!))}>
              {label}
            </Pill>
          ))}
        </PillRow>
        <input
          type="search"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder={`Search all ${zones.length} materials`}
          aria-label="Search materials"
          className="mt-2.5 h-[34px] w-full select-text rounded border border-steel-500 bg-steel-950 px-2.5 text-[13px] text-alu-200 placeholder:text-alu-500"
        />
        <ul className="scroll-steel mt-1.5 max-h-[168px] overflow-y-auto rounded border border-steel-700 bg-steel-900">
          {listed.slice(0, MAX_ROWS).map((zone) => (
            <ZoneRow key={zone.id} zone={zone} role={roleOf(zone)} state={build.paintZones[zone.id]} selected={zone.id === selected.id} onSelect={() => select(zone.id)} />
          ))}
          {listed.length === 0 ? <li className="px-2 py-2 text-[13px] text-alu-500">No material is called “{query.trim()}”.</li> : null}
          {listed.length > MAX_ROWS ? <li className="px-2 py-1.5 text-xs text-alu-500">{listed.length - MAX_ROWS} more. Keep typing to narrow it down.</li> : null}
        </ul>
      </Section>

      <Section title={selected.materialName} aside={`${ROLE_NAME[selectedRole]}, on ${selected.meshNames.length} ${selected.meshNames.length === 1 ? 'part' : 'parts'}`}>
        <div className="flex flex-wrap gap-1.5">
          <TextButton onClick={() => engine.flashZone(selected.id)} title="Flash this material on the car">
            <Crosshair size={13} />
            Show on car
          </TextButton>
          <TextButton onClick={() => engine.resetZones([selected.id])} disabled={!state?.modified}>
            <RotateCcw size={13} />
            Back to stock
          </TextButton>
          {siblings.length > 1 && state ? (
            <TextButton onClick={() => engine.paintZones(siblings, { ...state })} disabled={!state.modified}>
              Paint all {siblings.length} {ROLE_SHORTCUTS.find((r) => r.role === selectedRole)?.plural ?? 'zones'} to match
            </TextButton>
          ) : null}
        </div>
        {!state?.modified ? <Note>Still the material from the .blend file. Pick a color or move a slider to repaint it.</Note> : null}
      </Section>

      <Section title="Paint colors">
        <div className="grid grid-cols-4 gap-2">
          {presets.map((preset) => (
            <PaintChip
              key={preset.id}
              name={preset.name}
              color={preset.state.color}
              active={Boolean(state?.modified) && state?.color === preset.state.color && state?.finish === preset.state.finish}
              onClick={() => engine.paintZone(selected.id, preset.state)}
            />
          ))}
        </div>
        <label className="mt-3 flex items-center gap-2.5 text-[13px]">
          <input
            type="color"
            value={state?.color ?? '#808080'}
            onChange={(event) => engine.paintZone(selected.id, { color: event.target.value })}
            className="h-8 w-12 cursor-pointer rounded border border-steel-500 bg-steel-900 p-0.5"
          />
          Custom color
          <span className="tabular ml-auto select-text text-alu-500">{state?.color ?? ''}</span>
        </label>
      </Section>

      <Section title="Finish">
        <PillRow>
          {FINISHES.map(({ id, label }) => (
            <Pill key={id} active={Boolean(state?.modified) && state?.finish === id} onClick={() => engine.paintZone(selected.id, { finish: id, ...FINISH_PROFILES[id] })}>
              {label}
            </Pill>
          ))}
        </PillRow>
        {state ? (
          <div className="mt-3 grid gap-2">
            <Slider label="Metalness" value={state.metalness} min={0} max={1} step={0.01} display={state.metalness.toFixed(2)} onChange={(v) => engine.paintZone(selected.id, { metalness: v })} />
            <Slider label="Roughness" value={state.roughness} min={0} max={1} step={0.01} display={state.roughness.toFixed(2)} onChange={(v) => engine.paintZone(selected.id, { roughness: v })} />
            <Slider label="Clearcoat" value={state.clearcoat} min={0} max={1} step={0.01} display={state.clearcoat.toFixed(2)} onChange={(v) => engine.paintZone(selected.id, { clearcoat: v })} />
            <Slider label="Pearl shift" value={state.iridescence} min={0} max={1} step={0.01} display={state.iridescence.toFixed(2)} onChange={(v) => engine.paintZone(selected.id, { iridescence: v })} />
          </div>
        ) : null}
      </Section>

      {rig.caliperZones.length ? (
        <Section title="Brake calipers" aside={caliperColor?.modified ? undefined : 'stock'}>
          <div className="flex flex-wrap items-center gap-2">
            {CALIPER_COLORS.map(({ name, color }) => (
              <ColorDot
                key={color}
                name={`${name} calipers`}
                color={color}
                active={Boolean(caliperColor?.modified) && caliperColor?.color === color}
                onClick={() => engine.paintZones(rig.caliperZones, { color, finish: 'gloss', ...FINISH_PROFILES.gloss })}
              />
            ))}
            <TextButton onClick={() => engine.resetZones(rig.caliperZones)} disabled={!caliperColor?.modified}>
              Stock
            </TextButton>
          </div>
        </Section>
      ) : null}

      {rig.roleLeads.glass ? (
        <Section title="Glass tint" aside={tint ? undefined : 'stock'}>
          <div className="flex flex-wrap items-center gap-2">
            {GLASS_TINTS.map(({ name, color }) => (
              <ColorDot key={color} name={`${name} tint`} color={color} active={tint?.color === color} onClick={() => engine.setGlassTint({ color, darkness: tint?.darkness ?? 0.55 })} />
            ))}
            <TextButton onClick={() => engine.setGlassTint(null)} disabled={!tint}>
              Stock
            </TextButton>
          </div>
          <div className="mt-2">
            <Slider
              label="Darkness"
              value={tint?.darkness ?? 0.55}
              min={0}
              max={1}
              step={0.01}
              display={`${Math.round((tint?.darkness ?? 0.55) * 100)}%`}
              onChange={(v) => engine.setGlassTint({ color: tint?.color ?? GLASS_TINTS[0].color, darkness: v })}
            />
          </div>
        </Section>
      ) : null}
    </>
  );
}
