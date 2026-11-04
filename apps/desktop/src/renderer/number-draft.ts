/**
 * Parse a number being typed into a toolbar field. A comma is a decimal
 * separator on a Swedish keyboard, and a trailing separator is still on its
 * way to a complete value (`3,`), so both are accepted. Anything else is a
 * draft that must not be applied yet.
 */
export function parseNumberDraft(raw: string): number | undefined {
  const text = raw.trim();
  if (text === '') return undefined;
  if (!/^[+-]?(?:\d+(?:[.,]\d*)?|[.,]\d+)$/.test(text)) return undefined;
  const value = Number(text.replace(',', '.'));
  return Number.isFinite(value) ? value : undefined;
}

/** Round to the slider's step and clamp to its range, without float dust. */
export function clampNumber(value: number, min: number, max: number, step: number): number {
  // The epsilon makes a half-step at the limit of float precision round the way
  // a person expects (`3.55` at step 0.1 is 3.6, not 3.5).
  const steps = step > 0 ? Math.round((value - min) / step + 1e-9) : 0;
  const snapped = step > 0 ? min + steps * step : value;
  const clamped = Math.min(max, Math.max(min, snapped));
  return Number(clamped.toFixed(10));
}
