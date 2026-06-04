import { chromium, type Browser, type Page } from 'playwright-core';
import type {
  EasingName,
  ScrollStop,
  ScrollStyle,
  WaitUntil,
  WarmupMode,
} from '@page-capture/shared';
import { CaptureAbortedError } from '../errors';
import { buildFramePlan } from '../motion';
import { measureStableHeight, preparePage, warmUpPage } from '../page-prep';
import { createImageFrameSource } from './image';
import type { FrameSourceResult } from './types';

type WarnLogger = { warn?: (...args: unknown[]) => void };

/**
 * Resolve pause points to scroll offsets (px). Selectors are resolved against
 * the live DOM (element top -> document offset); offset/percent are arithmetic.
 * Unresolved selectors are warned about and skipped rather than failing the run.
 */
async function resolveStops(
  page: Page,
  stops: ScrollStop[] | undefined,
  distance: number,
  logger?: WarnLogger,
): Promise<Array<{ offset: number; holdMs?: number }> | undefined> {
  if (!stops || stops.length === 0) return undefined;

  const selectors = stops.filter((s) => s.selector !== undefined).map((s) => s.selector as string);
  const resolvedSelectors: Record<number, number | null> = selectors.length
    ? await page.evaluate((sels: string[]) => {
        const out: Record<number, number | null> = {};
        sels.forEach((sel, i) => {
          try {
            const el = document.querySelector(sel);
            out[i] = el
              ? Math.round(el.getBoundingClientRect().top + window.scrollY)
              : null;
          } catch {
            out[i] = null;
          }
        });
        return out;
      }, selectors)
    : {};

  const resolved: Array<{ offset: number; holdMs?: number }> = [];
  let si = 0;
  for (const s of stops) {
    let offset: number;
    if (s.selector !== undefined) {
      const o = resolvedSelectors[si++];
      if (o === null || o === undefined) {
        logger?.warn?.(`page-capture: stop selector not found, skipping: ${s.selector}`);
        continue;
      }
      offset = o;
    } else if (s.offset !== undefined) {
      offset = s.offset;
    } else {
      offset = Math.round(((s.percent as number) / 100) * distance);
    }
    resolved.push(s.holdMs !== undefined ? { offset, holdMs: s.holdMs } : { offset });
  }
  return resolved.length ? resolved : undefined;
}

export interface UrlSourceParams {
  url: string;
  outWidth: number;
  outHeight: number;
  scale: number;
  fps: number;
  scrollSpeed: number;
  duration?: number;
  minDurationS: number;
  maxDurationS: number;
  holdStartMs: number;
  holdEndMs: number;
  easing: EasingName;
  style?: ScrollStyle;
  roundTrip?: boolean;
  pageHoldMs?: number;
  pageScrollMs?: number;
  pageFraction?: number;
  mode: 'animate' | 'static';
  warmup: WarmupMode;
  waitUntil: WaitUntil;
  afterLoadMs: number;
  settlePerFrameMs: number;
  selectors?: string[];
  respectReducedMotion: boolean;
  hideFixed: boolean;
  maxHeightPx?: number;
  /** Reading style: explicit pause points (selector/offset/percent). */
  stops?: ScrollStop[];
  /** Override the browser User-Agent (defaults to a realistic desktop Chrome UA). */
  userAgent?: string;
  /** Host-controlled browser provisioning (the worker injects its own). */
  browserFactory?: () => Promise<Browser>;
  /** SSRF gate run before navigation (see CaptureRuntime.urlPolicy). */
  urlPolicy?: (url: URL) => void | Promise<void>;
  logger?: WarnLogger;
  signal?: AbortSignal;
}

function defaultBrowser(): Promise<Browser> {
  return chromium.launch({
    headless: true,
    args: [
      '--force-color-profile=srgb',
      '--hide-scrollbars',
      '--disable-dev-shm-usage',
      // Many real sites render differently (or block) when they detect automation.
      '--disable-blink-features=AutomationControlled',
    ],
  });
}

/** A realistic desktop Chrome UA so real sites don't serve a bot/headless variant. */
function realisticUserAgent(version: string): string {
  const v = /^\d+\./.test(version) ? version : '133.0.0.0';
  return `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${v} Safari/537.36`;
}

/**
 * URL mode: drive a real browser and capture a deterministic, per-frame scroll.
 * Scroll-triggered animations fire on scroll *position*, so stepping to each
 * eased offset reproduces them faithfully while keeping the output smooth and
 * exactly the intended duration.
 */
export async function createUrlFrameSource(
  p: UrlSourceParams,
): Promise<FrameSourceResult> {
  if (p.signal?.aborted) throw new CaptureAbortedError();

  const scale = p.scale > 0 ? p.scale : 1;
  // The CSS viewport equals the OUTPUT size (true desktop layout). A scale > 1
  // renders at higher density (supersampling); the encoder downscales to output.
  const viewportW = p.outWidth;
  const viewportH = p.outHeight;

  const browser = await (p.browserFactory ?? defaultBrowser)();
  try {
    const context = await browser.newContext({
      viewport: { width: viewportW, height: viewportH },
      deviceScaleFactor: scale,
      userAgent: p.userAgent ?? realisticUserAgent(browser.version()),
    });
    const page = await context.newPage();
    await page.emulateMedia({
      reducedMotion: p.respectReducedMotion ? 'reduce' : 'no-preference',
    });

    await preparePage(page, {
      url: p.url,
      waitUntil: p.waitUntil,
      afterLoadMs: p.afterLoadMs,
      selectors: p.selectors,
      hideFixed: p.hideFixed,
      signal: p.signal,
      urlPolicy: p.urlPolicy,
    });
    await warmUpPage(page, p.warmup, p.signal);
    if (p.signal?.aborted) throw new CaptureAbortedError();

    const contentHeight = await measureStableHeight(page, p.maxHeightPx, p.signal);
    if (p.signal?.aborted) throw new CaptureAbortedError();

    const motion = {
      fps: p.fps,
      scrollSpeed: p.scrollSpeed,
      duration: p.duration,
      minDurationS: p.minDurationS,
      maxDurationS: p.maxDurationS,
      holdStartMs: p.holdStartMs,
      holdEndMs: p.holdEndMs,
      easing: p.easing,
      style: p.style,
      roundTrip: p.roundTrip,
      pageHoldMs: p.pageHoldMs,
      pageScrollMs: p.pageScrollMs,
      pageFraction: p.pageFraction,
    };

    if (p.mode === 'static') {
      // One full-page screenshot, then pan it exactly like the image source.
      const shot = await page.screenshot({ fullPage: true, type: 'png' });
      await browser.close().catch(() => undefined);
      return createImageFrameSource({
        input: { data: shot },
        outWidth: p.outWidth,
        outHeight: p.outHeight,
        ...(p.stops ? { stops: p.stops } : {}),
        ...(p.logger ? { logger: p.logger } : {}),
        ...motion,
      });
    }

    const resolvedStops = await resolveStops(
      page,
      p.stops,
      Math.max(0, contentHeight - viewportH),
      p.logger,
    );

    const framePlan = buildFramePlan({
      contentHeight,
      viewportHeight: viewportH,
      ...motion,
      ...(resolvedStops ? { stops: resolvedStops } : {}),
    });

    let closed = false;
    const close = async (): Promise<void> => {
      if (closed) return;
      closed = true;
      await browser.close().catch(() => undefined);
    };

    // Real-time capture: scroll, settle (2x rAF + a macrotask so IntersectionObserver
    // and transitions advance), screenshot. Smooth, correct-speed animation playback
    // is the job of the beginFrame source (createBeginFrameUrlSource); this is the
    // real-time path used when the virtual clock is off or unavailable.
    const frames = (async function* (): AsyncIterable<Buffer> {
      try {
        for (let i = 0; i < framePlan.totalFrames; i++) {
          if (p.signal?.aborted) throw new CaptureAbortedError();
          await page.evaluate(
            (y) =>
              new Promise<void>((r) => {
                window.scrollTo(0, y);
                requestAnimationFrame(() =>
                  requestAnimationFrame(() => setTimeout(() => r(), 0)),
                );
              }),
            framePlan.offsetForFrame(i),
          );
          if (p.settlePerFrameMs > 0) await page.waitForTimeout(p.settlePerFrameMs);
          // Viewport screenshot (NOT clip — clip is document-relative and would
          // not follow the scroll). Viewport size × DSF == output dimensions.
          yield await page.screenshot({ type: 'png', animations: 'allow' });
        }
      } finally {
        await close();
      }
    })();

    return {
      framePlan,
      inputFormat: { kind: 'png' },
      outWidth: p.outWidth,
      outHeight: p.outHeight,
      frames,
      dispose: close,
    };
  } catch (err) {
    await browser.close().catch(() => undefined);
    throw err;
  }
}
