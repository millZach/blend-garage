import { RIM_FINISH_PRESETS, STANCE_LIMITS, type UniversalWheelOverlay } from '@blend-garage/vehicle-core';
import { Note, PaintChip, Pill, PillRow, Section, Slider, TextButton } from '../controls';
import { useEngine, useGarage } from '../engine';
import { formatDegrees, formatMillimeters } from '../format';

const WHEEL_FACES: { id: UniversalWheelOverlay; label: string }[] = [
  { id: 'stock', label: 'Stock' },
  { id: 'five-spoke', label: 'Five spoke' },
  { id: 'mesh-dish', label: 'Mesh dish' },
  { id: 'aero-disc', label: 'Aero disc' },
];

/** Wheel faces, rim finish and the stance: ride height, camber, spacers, steering and a dyno spin. */
export function WheelsDrawer() {
  const engine = useEngine();
  const rig = useGarage((s) => s.rig);
  const build = useGarage((s) => s.build);
  if (!rig || !build) return null;

  const stance = build.stance;
  const found = rig.wheels.length;
  const radius = found ? rig.wheels.reduce((sum, w) => sum + w.radius, 0) / found : 0.33;
  const roadSpeed = Math.round(stance.wheelSpinSpeed * radius * 3.6);
  const rimZones = rig.roleZones.rim?.length ?? 0;

  return (
    <>
      {found < 4 ? (
        <Note>
          {found === 0
            ? 'No wheels could be located on this model, so the controls here have nothing to move.'
            : `Only ${found} of 4 wheels could be located on this model. The controls here move the ones that were found.`}
        </Note>
      ) : null}

      <Section title="Wheel face">
        <PillRow>
          {WHEEL_FACES.map(({ id, label }) => (
            <Pill key={id} active={build.universalParts.wheelStyle === id} onClick={() => engine.setUniversalParts({ wheelStyle: id })} disabled={found === 0}>
              {label}
            </Pill>
          ))}
        </PillRow>
      </Section>

      <Section title="Rim finish" aside={build.rimFinish ? undefined : 'stock'}>
        <div className="grid grid-cols-4 gap-2">
          {RIM_FINISH_PRESETS.map((preset) => (
            <PaintChip key={preset.id} name={preset.name} color={preset.state.color} active={build.rimFinish?.color === preset.state.color} onClick={() => engine.setRimFinish(preset.state)} />
          ))}
        </div>
        <div className="mt-2">
          <TextButton onClick={() => engine.setRimFinish(null)} disabled={!build.rimFinish}>
            Stock rims
          </TextButton>
        </div>
        <Note>
          {rimZones > 0
            ? `Colors the replacement wheel faces and this car’s ${rimZones} rim ${rimZones === 1 ? 'material' : 'materials'}.`
            : 'This car has no material marked as a rim, so the finish shows on the replacement wheel faces only.'}
        </Note>
      </Section>

      <Section title="Stance">
        <div className="grid gap-2">
          <Slider
            label="Ride height"
            value={stance.rideHeightOffset}
            min={STANCE_LIMITS.rideHeightOffset.min}
            max={STANCE_LIMITS.rideHeightOffset.max}
            step={0.005}
            resetTo={0}
            display={formatMillimeters(stance.rideHeightOffset, true)}
            onChange={(v) => engine.setStance({ rideHeightOffset: v })}
          />
          <Slider
            label="Camber"
            value={stance.camberDeg}
            min={STANCE_LIMITS.camberDeg.min}
            max={STANCE_LIMITS.camberDeg.max}
            step={0.1}
            resetTo={0}
            display={formatDegrees(stance.camberDeg, true)}
            onChange={(v) => engine.setStance({ camberDeg: v })}
            disabled={found === 0}
          />
          <Slider
            label="Wheel spacers"
            value={stance.trackOffset}
            min={STANCE_LIMITS.trackOffset.min}
            max={STANCE_LIMITS.trackOffset.max}
            step={0.001}
            resetTo={0}
            display={formatMillimeters(stance.trackOffset, true)}
            onChange={(v) => engine.setStance({ trackOffset: v })}
            disabled={found === 0}
          />
          <Slider
            label="Front steering"
            value={stance.frontSteerAngle}
            min={STANCE_LIMITS.frontSteerAngle.min}
            max={STANCE_LIMITS.frontSteerAngle.max}
            step={0.5}
            resetTo={0}
            display={formatDegrees(stance.frontSteerAngle, true)}
            onChange={(v) => engine.setStance({ frontSteerAngle: v })}
            disabled={found === 0}
          />
        </div>
      </Section>

      <Section title="Dyno spin" aside={stance.wheelSpinSpeed > 0 ? `about ${roadSpeed} km/h` : 'stopped'}>
        <Slider
          label="Wheel speed"
          value={stance.wheelSpinSpeed}
          min={STANCE_LIMITS.wheelSpinSpeed.min}
          max={STANCE_LIMITS.wheelSpinSpeed.max}
          step={0.5}
          resetTo={0}
          display={`${Math.round((stance.wheelSpinSpeed / (Math.PI * 2)) * 60)} rpm`}
          onChange={(v) => engine.setStance({ wheelSpinSpeed: v })}
          disabled={found === 0}
        />
        <div className="mt-2 flex gap-1.5">
          <Pill active={stance.wheelSpinSpeed === 0} onClick={() => engine.setStance({ wheelSpinSpeed: 0 })}>
            Stop
          </Pill>
          <Pill active={stance.wheelSpinSpeed === 8} onClick={() => engine.setStance({ wheelSpinSpeed: 8 })} disabled={found === 0}>
            Idle roll
          </Pill>
          <Pill active={stance.wheelSpinSpeed === 28} onClick={() => engine.setStance({ wheelSpinSpeed: 28 })} disabled={found === 0}>
            Full pull
          </Pill>
        </div>
      </Section>
    </>
  );
}
