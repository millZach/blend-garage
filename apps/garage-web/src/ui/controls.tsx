import { useEffect, useId, useRef, type CSSProperties, type ReactNode } from 'react';
import { X } from 'lucide-react';

/** A titled block inside a drawer tray. */
export function Section({ title, aside, children }: { title: string; aside?: ReactNode; children: ReactNode }) {
  return (
    <section>
      <div className="mb-2 flex items-baseline justify-between gap-3">
        <h4 className="text-[13px] font-semibold text-white">{title}</h4>
        {aside ? <div className="text-xs text-alu-500">{aside}</div> : null}
      </div>
      {children}
    </section>
  );
}

export function Note({ children }: { children: ReactNode }) {
  return <p className="mt-2 text-xs leading-snug text-alu-500">{children}</p>;
}

interface PillProps {
  active?: boolean;
  disabled?: boolean;
  onClick: () => void;
  children: ReactNode;
  title?: string;
}

/** A stamped steel button. `active` lights it in lift yellow. */
export function Pill({ active = false, disabled = false, onClick, children, title }: PillProps) {
  return (
    <button
      type="button"
      title={title}
      disabled={disabled}
      aria-pressed={active}
      onClick={onClick}
      className={`rounded px-2.5 py-1.5 text-[13px] leading-none transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${
        active ? 'border border-lift-500 bg-lift-500 font-bold text-steel-950' : 'border border-steel-500 bg-steel-700 text-alu-300 hover:border-alu-500 hover:text-white'
      }`}
    >
      {children}
    </button>
  );
}

export function PillRow({ children }: { children: ReactNode }) {
  return <div className="flex flex-wrap gap-1.5">{children}</div>;
}

interface SliderProps {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  /** How the current value reads next to the label. */
  display: string;
  onChange: (value: number) => void;
  /** Double-clicking the track returns to this value. */
  resetTo?: number;
  disabled?: boolean;
}

export function Slider({ label, value, min, max, step, display, onChange, resetTo, disabled = false }: SliderProps) {
  const id = useId();
  const fill = `${((value - min) / (max - min)) * 100}%`;
  return (
    <div className={disabled ? 'opacity-40' : undefined}>
      <div className="flex items-baseline justify-between text-[13px]">
        <label htmlFor={id}>{label}</label>
        <span className="tabular text-white">{display}</span>
      </div>
      <input
        id={id}
        type="range"
        className="slider"
        style={{ '--fill': fill } as CSSProperties}
        min={min}
        max={max}
        step={step}
        value={value}
        disabled={disabled}
        onChange={(event) => onChange(Number(event.target.value))}
        onDoubleClick={resetTo === undefined ? undefined : () => onChange(resetTo)}
        title={resetTo === undefined ? undefined : 'Double-click to reset'}
      />
    </div>
  );
}

interface ToggleRowProps {
  label: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
  hint?: string;
}

/** A labelled switch on one row. */
export function ToggleRow({ label, checked, onChange, hint }: ToggleRowProps) {
  return (
    <label className="relative flex cursor-pointer items-center justify-between gap-3 border-t border-steel-700 py-1.5 text-[13px] first:border-t-0">
      <span className="min-w-0">
        <span className="block truncate">{label}</span>
        {hint ? <span className="block truncate text-xs text-alu-500">{hint}</span> : null}
      </span>
      <input type="checkbox" className="peer sr-only" checked={checked} onChange={(event) => onChange(event.target.checked)} />
      <span
        aria-hidden
        className="relative h-[18px] w-[34px] flex-none rounded-full bg-steel-500 transition-colors peer-checked:bg-lift-500 peer-focus-visible:outline peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-lift-500 after:absolute after:left-0.5 after:top-0.5 after:h-[14px] after:w-[14px] after:rounded-full after:bg-steel-950 after:transition-transform peer-checked:after:translate-x-4"
      />
    </label>
  );
}

interface PaintChipProps {
  name: string;
  color: string;
  active?: boolean;
  onClick: () => void;
}

/** A paint-shop color chip: the color above, its name on the card below. */
export function PaintChip({ name, color, active = false, onClick }: PaintChipProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={`overflow-hidden rounded-sm bg-[#f3f1ea] text-left text-ink shadow-[0_2px_6px_rgb(0_0_0/0.5)] ${active ? 'outline outline-[3px] outline-lift-500' : 'hover:brightness-110'}`}
    >
      <span className="block h-9" style={{ backgroundColor: color, backgroundImage: 'linear-gradient(135deg, rgb(255 255 255 / 0.35), transparent 45%, rgb(0 0 0 / 0.25))' }} />
      <span className="font-narrow block min-h-[30px] px-1.5 pb-1 pt-1 text-[11px] font-semibold leading-[1.1]">{name}</span>
    </button>
  );
}

/** A plain round color dot for quick picks. */
export function ColorDot({ name, color, active = false, onClick }: PaintChipProps) {
  return (
    <button
      type="button"
      title={name}
      aria-label={name}
      aria-pressed={active}
      onClick={onClick}
      className={`h-7 w-7 rounded-full border-2 ${active ? 'border-lift-500' : 'border-steel-500 hover:border-alu-300'}`}
      style={{ backgroundColor: color }}
    />
  );
}

interface TextButtonProps {
  onClick: () => void;
  children: ReactNode;
  disabled?: boolean;
  tone?: 'plain' | 'danger';
  title?: string;
}

/** A flat utility button for actions inside a tray (export, import, refresh). */
export function TextButton({ onClick, children, disabled = false, tone = 'plain', title }: TextButtonProps) {
  return (
    <button
      type="button"
      title={title}
      disabled={disabled}
      onClick={onClick}
      className={`inline-flex items-center gap-1.5 rounded border px-2.5 py-1.5 text-[13px] leading-none transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${
        tone === 'danger' ? 'border-chest-500 text-chest-400 hover:bg-chest-500 hover:text-white' : 'border-steel-500 bg-steel-700 text-alu-300 hover:border-alu-500 hover:text-white'
      }`}
    >
      {children}
    </button>
  );
}

/** A centered dialog. Closes on Escape, on the close button, or on a click outside it. */
export function Modal({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  const panelRef = useRef<HTMLDivElement>(null);
  const titleId = useId();

  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    panelRef.current?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        onClose();
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => {
      window.removeEventListener('keydown', onKey, true);
      previous?.focus();
    };
  }, [onClose]);

  return (
    <div className="absolute inset-0 z-40 grid place-items-center bg-black/60 p-6" onPointerDown={(event) => event.target === event.currentTarget && onClose()}>
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        className="scroll-steel max-h-full w-full max-w-[640px] overflow-y-auto rounded-md bg-paper text-ink shadow-[0_30px_80px_rgb(0_0_0/0.6)] outline-none"
      >
        <div className="flex items-start justify-between gap-4 border-b border-paper-dim px-6 pb-3 pt-5">
          <h2 id={titleId} className="font-badge text-xl font-extrabold leading-tight">
            {title}
          </h2>
          <button type="button" onClick={onClose} aria-label="Close" className="rounded p-1 text-ink-soft hover:bg-black/10 hover:text-ink">
            <X size={20} />
          </button>
        </div>
        <div className="select-text px-6 pb-6 pt-4 text-[15px] leading-relaxed">{children}</div>
      </div>
    </div>
  );
}
