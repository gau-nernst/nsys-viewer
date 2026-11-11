/** The WASD keys of Perfetto and chrome://tracing: hold W / S to zoom in / out, A / D to pan left / right. */
const ZOOM_KEYS: Record<string, -1 | 1> = { w: -1, s: 1 };
const PAN_KEYS: Record<string, -1 | 1> = { a: -1, d: 1 };

/** Span factor per millisecond held: about 12x per second. */
export const ZOOM_RATE_PER_MS = 0.0025;
/** View widths per millisecond held: about one view per second. */
export const PAN_RATE_PER_MS = 0.001;

const has = (keys: Record<string, number>, key: string) => Object.prototype.hasOwnProperty.call(keys, key);

export function isNavKey(key: string): boolean {
  return has(ZOOM_KEYS, key) || has(PAN_KEYS, key);
}

/**
 * The view after zooming by `factor` around the point at `anchorFraction` (0 = left edge,
 * 1 = right edge) of [start, end]: that point stays where it is on screen.
 */
export function zoomedView(start: number, end: number, anchorFraction: number,
  factor: number): { start: number; end: number } {
  const span = end - start;
  const anchor = start + span * anchorFraction;
  const next = span * factor;
  return { start: anchor - next * anchorFraction, end: anchor - next * anchorFraction + next };
}

/** The view after `held` keys were down for `elapsedMs`: zoom around the anchor, then pan. */
export function heldKeysView(start: number, end: number, held: Iterable<string>, elapsedMs: number,
  anchorFraction: number): { start: number; end: number } {
  let zoom = 0;
  let pan = 0;
  for (const key of held) {
    if (has(ZOOM_KEYS, key)) zoom += ZOOM_KEYS[key];
    if (has(PAN_KEYS, key)) pan += PAN_KEYS[key];
  }
  const view = zoom ? zoomedView(start, end, anchorFraction, Math.exp(zoom * elapsedMs * ZOOM_RATE_PER_MS))
    : { start, end };
  const shift = pan * elapsedMs * PAN_RATE_PER_MS * (view.end - view.start);
  return { start: view.start + shift, end: view.end + shift };
}

/** True when keys typed into this target should not drive the timeline. */
export function isTextEntry(target: EventTarget | null): boolean {
  if (!target || typeof (target as Element).closest !== "function") return false;
  return !!(target as Element).closest("input, textarea, select, [contenteditable]");
}
