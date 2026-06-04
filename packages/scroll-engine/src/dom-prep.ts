import type { ScrollStop } from '@page-capture/shared';

/** Common "accept cookies" / consent buttons, tried best-effort (text matched case-insensitively). */
export const DEFAULT_CONSENT_SELECTORS = [
  '#onetrust-accept-btn-handler',
  '#truste-consent-button',
  'button#accept',
  'button[aria-label="Accept all" i]',
];
/** Visible-text buttons to click if no selector matched (lowercased contains-match). */
export const DEFAULT_CONSENT_TEXTS = ['accept all', 'accept', 'i agree', 'got it'];

export function neutralizeLazyImages(doc: Document): Promise<void> {
  const images = Array.from(doc.querySelectorAll<HTMLImageElement>('img'));
  for (const img of images) {
    const ds = img.getAttribute('data-src');
    if (ds && !img.getAttribute('src')) img.setAttribute('src', ds);
    const dss = img.getAttribute('data-srcset');
    if (dss && !img.getAttribute('srcset')) img.setAttribute('srcset', dss);
    img.loading = 'eager';
  }
  return Promise.all(
    images.map((i) => (i.complete ? Promise.resolve() : i.decode().catch(() => undefined))),
  ).then(() => undefined);
}

export function hideFixedElements(doc: Document): void {
  for (const el of Array.from(doc.querySelectorAll('body *'))) {
    const pos = getComputedStyle(el).position;
    if (pos === 'fixed' || pos === 'sticky') (el as HTMLElement).style.visibility = 'hidden';
  }
}

/** Click the first matching consent control. Returns true if one was clicked. */
export function dismissConsent(doc: Document, userSelectors: string[] = []): boolean {
  for (const sel of [...userSelectors, ...DEFAULT_CONSENT_SELECTORS]) {
    try {
      const el = doc.querySelector<HTMLElement>(sel);
      if (el && el.offsetParent !== null) { el.click(); return true; }
    } catch { /* invalid selector — ignore */ }
  }
  const buttons = Array.from(doc.querySelectorAll<HTMLElement>('button, [role="button"]'));
  for (const text of DEFAULT_CONSENT_TEXTS) {
    const hit = buttons.find((b) => (b.textContent ?? '').trim().toLowerCase() === text);
    if (hit && hit.offsetParent !== null) { hit.click(); return true; }
  }
  return false;
}

/**
 * Poll a height reader until it is stable across `stableReads` consecutive equal
 * reads (lazy content keeps growing it), capped by maxHeightPx. `sleep` and
 * `readHeight` are injected so this is pure-testable.
 */
export async function measureStableHeight(
  readHeight: () => number,
  opts: { maxHeightPx?: number; maxReads?: number; stableReads?: number; sleep: (ms: number) => Promise<void>; intervalMs?: number },
): Promise<number> {
  const maxReads = opts.maxReads ?? 15;
  const need = opts.stableReads ?? 3;
  const interval = opts.intervalMs ?? 80;
  let last = -1, stable = 0, height = 0;
  for (let i = 0; i < maxReads; i++) {
    height = readHeight();
    if (height === last) { if (++stable >= need) break; } else { stable = 0; last = height; }
    await opts.sleep(interval);
  }
  return opts.maxHeightPx ? Math.min(height, opts.maxHeightPx) : height;
}

/**
 * Resolve pause points to scroll offsets (px). Selector → element top + scrollY
 * (via injected measurer, default DOM); offset/percent are arithmetic. Unresolved
 * selectors are reported via onWarn and skipped.
 */
export function resolveStops(
  stops: ScrollStop[] | undefined,
  distance: number,
  onWarn: (msg: string) => void,
  measure: (sel: string) => number | null = (sel) => {
    const el = document.querySelector(sel);
    return el ? Math.round(el.getBoundingClientRect().top + window.scrollY) : null;
  },
): Array<{ offset: number; holdMs?: number }> | undefined {
  if (!stops || stops.length === 0) return undefined;
  const out: Array<{ offset: number; holdMs?: number }> = [];
  for (const s of stops) {
    let offset: number;
    if (s.selector !== undefined) {
      const o = measure(s.selector);
      if (o === null) { onWarn(`stop selector not found, skipping: ${s.selector}`); continue; }
      offset = o;
    } else if (s.offset !== undefined) offset = s.offset;
    else offset = Math.round(((s.percent as number) / 100) * distance);
    out.push(s.holdMs !== undefined ? { offset, holdMs: s.holdMs } : { offset });
  }
  return out.length ? out : undefined;
}
