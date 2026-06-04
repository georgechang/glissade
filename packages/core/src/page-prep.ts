import type { Page } from 'playwright-core';
import type { WaitUntil, WarmupMode } from '@page-capture/shared';
import { CaptureAbortedError, NavigationError } from './errors';

const throwIfAborted = (signal?: AbortSignal): void => {
  if (signal?.aborted) throw new CaptureAbortedError();
};

/** Common "accept cookies" / consent buttons, tried best-effort before capture. */
export const DEFAULT_CONSENT_SELECTORS = [
  '#onetrust-accept-btn-handler',
  '#truste-consent-button',
  'button#accept',
  'button[aria-label="Accept all"]',
  'button[aria-label="Accept All"]',
  'button:has-text("Accept all")',
  'button:has-text("Accept All")',
  'button:has-text("I agree")',
  'button:has-text("Got it")',
];

export interface PrepareOptions {
  url: string;
  waitUntil: WaitUntil;
  afterLoadMs: number;
  selectors?: string[];
  hideFixed: boolean;
  signal?: AbortSignal;
  /** Optional gate run BEFORE navigation — throw to deny a URL (SSRF allow-listing). */
  urlPolicy?: (url: URL) => void | Promise<void>;
}

async function dismissConsent(page: Page, userSelectors: string[] = []): Promise<void> {
  const selectors = [...userSelectors, ...DEFAULT_CONSENT_SELECTORS];
  for (const sel of selectors) {
    try {
      const loc = page.locator(sel).first();
      if ((await loc.count()) > 0 && (await loc.isVisible())) {
        await loc.click({ timeout: 1000 }).catch(() => undefined);
        break;
      }
    } catch {
      /* invalid selector or detached node — ignore */
    }
  }
}

async function hideFixedElements(page: Page): Promise<void> {
  await page
    .evaluate(() => {
      for (const el of Array.from(document.querySelectorAll('body *'))) {
        const pos = getComputedStyle(el).position;
        if (pos === 'fixed' || pos === 'sticky') {
          (el as HTMLElement).style.visibility = 'hidden';
        }
      }
    })
    .catch(() => undefined);
}

/** Navigate and bring the page to a stable, capture-ready state. */
export async function preparePage(page: Page, o: PrepareOptions): Promise<void> {
  throwIfAborted(o.signal);

  // SSRF gate: let the host deny a URL (e.g. private/metadata hosts) before we navigate.
  if (o.urlPolicy) await o.urlPolicy(new URL(o.url));

  try {
    await page.goto(o.url, { waitUntil: o.waitUntil, timeout: 45_000 });
  } catch (e) {
    throw new NavigationError(`failed to load ${o.url}: ${(e as Error).message}`);
  }
  throwIfAborted(o.signal);

  // Wait for web fonts so FOUT reflow doesn't shift content mid-capture.
  await page
    .evaluate(() => (document.fonts ? document.fonts.ready.then(() => undefined) : undefined))
    .catch(() => undefined);

  // Settle FIRST. This lets a bot-check interstitial (e.g. Cloudflare "Just a
  // moment…") clear and the real page render before we touch consent/styles.
  if (o.afterLoadMs > 0) await page.waitForTimeout(o.afterLoadMs);
  throwIfAborted(o.signal);

  // Force native smooth-scroll off so our scrollTo lands exactly and isn't re-animated.
  await page
    .addStyleTag({ content: 'html{scroll-behavior:auto !important}' })
    .catch(() => undefined);

  await dismissConsent(page, o.selectors);
  if (o.hideFixed) await hideFixedElements(page);
}

/**
 * Warm up the page before the recorded pass.
 *  - 'none':   record cold — reveals fire during recording; lazy media loads on demand.
 *  - 'images': neutralize lazy loaders IN PLACE (no scroll), so media is present
 *              and scroll reveals stay armed to fire fresh during the recorded pass.
 *  - 'full':   pre-scroll to force-load everything; NOTE this triggers (and thus
 *              consumes) once-only scroll reveals — for static / no-reveal pages.
 *
 * The key distinction: loading lazy media does not require scrolling, so 'images'
 * never triggers scroll-position reveals (the headline animations we want to capture).
 */
export async function warmUpPage(
  page: Page,
  mode: WarmupMode,
  signal?: AbortSignal,
): Promise<void> {
  if (mode === 'none') return;
  throwIfAborted(signal);

  if (mode === 'full') {
    // Force-load everything by walking the page top-to-bottom. This fires scroll
    // reveals (acceptable for 'full', which targets static pages).
    await page.evaluate(async () => {
      const step = Math.max(200, window.innerHeight);
      const max = document.documentElement.scrollHeight;
      for (let y = 0; y <= max; y += step) {
        window.scrollTo(0, y);
        await new Promise((r) => requestAnimationFrame(() => r(undefined)));
      }
      window.scrollTo(0, document.documentElement.scrollHeight);
    });
    await page.waitForLoadState('networkidle').catch(() => undefined);
  }

  // Neutralize lazy loaders so media is present. Done WITHOUT scrolling, so for
  // 'images' no scroll reveal is triggered and they remain armed for recording.
  await page.evaluate(async () => {
    for (const img of Array.from(document.images)) {
      const ds = img.getAttribute('data-src');
      if (ds && !img.getAttribute('src')) img.setAttribute('src', ds);
      const dss = img.getAttribute('data-srcset');
      if (dss && !img.getAttribute('srcset')) img.setAttribute('srcset', dss);
      img.loading = 'eager';
    }
    await Promise.all(
      Array.from(document.images).map((i) =>
        i.complete ? Promise.resolve() : i.decode().catch(() => undefined),
      ),
    );
  });

  throwIfAborted(signal);
  if (mode === 'full') await page.evaluate(() => window.scrollTo(0, 0));
  await page.waitForTimeout(50);
}

/**
 * Measure the page's scrollable height, polling until it is stable across
 * several reads (lazy content/fonts can keep growing it). Capped by maxHeightPx.
 */
export async function measureStableHeight(
  page: Page,
  maxHeightPx?: number,
  signal?: AbortSignal,
): Promise<number> {
  let last = -1;
  let stable = 0;
  let height = 0;
  for (let i = 0; i < 15; i++) {
    throwIfAborted(signal);
    height = await page.evaluate(() => document.documentElement.scrollHeight);
    if (height === last) {
      if (++stable >= 3) break;
    } else {
      stable = 0;
      last = height;
    }
    await page.waitForTimeout(80);
  }
  return maxHeightPx ? Math.min(height, maxHeightPx) : height;
}
