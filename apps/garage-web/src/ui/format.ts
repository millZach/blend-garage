export function formatTriangles(count: number): string {
  if (count >= 1_000_000) return `${(count / 1_000_000).toFixed(2)}M`;
  if (count >= 1_000) return `${Math.round(count / 1_000)}k`;
  return String(count);
}

export function formatMeters(value: number): string {
  return `${value.toFixed(2)} m`;
}

export function formatMillimeters(meters: number, signed = false): string {
  const mm = Math.round(meters * 1000);
  return `${signed && mm > 0 ? '+' : ''}${mm} mm`;
}

export function formatDegrees(value: number, signed = false): string {
  const rounded = Math.round(value * 10) / 10;
  return `${signed && rounded > 0 ? '+' : ''}${rounded.toFixed(1)}°`;
}

export function formatClock(epochMs: number): string {
  return new Date(epochMs).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

/** "front_bumper" or "Front bumper lower return.001" as a short label a person would use. */
export function tidyLabel(raw: string): string {
  const text = raw
    .replace(/[_]+/g, ' ')
    .replace(/\.\d+$/, '')
    .replace(/\s+/g, ' ')
    .trim();
  return text ? text[0].toUpperCase() + text.slice(1) : raw;
}
