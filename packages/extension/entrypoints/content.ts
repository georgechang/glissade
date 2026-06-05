import { CaptureOptionsSchema } from '@page-capture/shared';
import {
  buildFramePlan, frameAtElapsed, dismissConsent, hideFixedElements,
  measureStableHeight, neutralizeLazyImages, resolveStops,
} from '@page-capture/scroll-engine';
import { isMessage } from '../src/messages';

let lastPlan: { totalFrames: number; offsetForFrame: (i: number) => number } | null = null;
let driveAborted = false;

export default defineContentScript({
  matches: ['http://*/*', 'https://*/*'],
  registration: 'manifest',
  runAt: 'document_start',
  main() {
    // Signal the new page's first paint so the background can start recording before
    // entrance animations begin. (Paint Holding shows the old page until this fires.)
    let firstPaintSent = false;
    const reportFirstPaint = () => {
      if (firstPaintSent) return;
      firstPaintSent = true;
      browser.runtime.sendMessage({ type: 'page:firstPaint' }).catch(() => {});
    };
    try {
      const po = new PerformanceObserver((list) => {
        for (const e of list.getEntries()) if (e.name === 'first-contentful-paint') { po.disconnect(); reportFirstPaint(); }
      });
      po.observe({ type: 'paint', buffered: true });
    } catch { /* PerformanceObserver unavailable */ }
    requestAnimationFrame(() => requestAnimationFrame(reportFirstPaint)); // after the first compositor paint
    setTimeout(reportFirstPaint, 300); // final fallback

    // drive:start → prep DOM + measure the plan, respond with {totalFrames,width,height}
    browser.runtime.onMessage.addListener((raw, _sender, sendResponse) => {
      if (!isMessage(raw) || raw.type !== 'drive:start') return;
      void prepareAndReportPlan(raw.fps, raw.options).then(sendResponse);
      return true; // async sendResponse
    });
    // scroll:start → run the wall-clock scroll
    browser.runtime.onMessage.addListener((raw) => {
      if (!isMessage(raw)) return;
      if (raw.type === 'scroll:start' && lastPlan) void drive(raw.fps, lastPlan);
      else if (raw.type === 'abort') driveAborted = true;
    });
  },
});

async function prepareAndReportPlan(fps: number, rawOptions: unknown) {
  const opts = CaptureOptionsSchema.parse(rawOptions);
  document.documentElement.style.setProperty('scroll-behavior', 'auto', 'important');
  if (document.fonts) await document.fonts.ready.catch(() => undefined);
  dismissConsent(document, opts.waits.selectors ?? []);
  if (opts.hideFixed) hideFixedElements(document);
  await neutralizeLazyImages(document);
  const viewportHeight = window.innerHeight;
  const contentHeight = await measureStableHeight(
    () => document.documentElement.scrollHeight,
    { ...(opts.maxHeightPx !== undefined ? { maxHeightPx: opts.maxHeightPx } : {}),
      sleep: (ms) => new Promise((r) => setTimeout(r, ms)) },
  );
  const distance = Math.max(0, Math.round(contentHeight - viewportHeight));
  const stops = resolveStops(opts.stops, distance, (msg) => console.warn('page-capture:', msg));
  const plan = buildFramePlan({
    contentHeight, viewportHeight, fps, scrollSpeed: opts.scrollSpeed,
    ...(opts.duration !== undefined ? { duration: opts.duration } : {}),
    minDurationS: opts.minDurationS, maxDurationS: opts.maxDurationS,
    holdStartMs: opts.pageHoldMs, holdEndMs: opts.holds.endMs, easing: opts.easing,
    style: opts.scrollStyle, roundTrip: opts.roundTrip,
    pageHoldMs: opts.pageHoldMs, pageScrollMs: opts.pageScrollMs, pageFraction: opts.pageFraction,
    ...(stops ? { stops } : {}),
  });
  lastPlan = { totalFrames: plan.totalFrames, offsetForFrame: plan.offsetForFrame };
  const dpr = Math.min(window.devicePixelRatio || 1, 2); // capture at native px (capped 2×) → crisp text
  return { totalFrames: plan.totalFrames, width: Math.round(window.innerWidth * dpr), height: Math.round(viewportHeight * dpr) };
}

async function drive(fps: number, plan: { totalFrames: number; offsetForFrame: (i: number) => number }) {
  driveAborted = false;
  window.scrollTo(0, 0);
  await new Promise((r) => requestAnimationFrame(() => r(undefined)));
  const t0 = performance.now();
  const onVisibility = () => {
    if (document.visibilityState === 'hidden' && !driveAborted) {
      driveAborted = true;
      browser.runtime.sendMessage({ type: 'abort' }).catch(() => {});
      console.warn('page-capture: tab left foreground — capture aborted');
    }
  };
  document.addEventListener('visibilitychange', onVisibility);
  try {
    await new Promise<void>((resolve) => {
      const tick = () => {
        if (driveAborted) { resolve(); return; }
        const frame = frameAtElapsed(performance.now() - t0, fps, plan.totalFrames);
        window.scrollTo(0, plan.offsetForFrame(frame));
        browser.runtime.sendMessage({ type: 'drive:progress', frame, totalFrames: plan.totalFrames }).catch(() => {});
        if (frame >= plan.totalFrames - 1) { resolve(); return; }
        requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    });
  } finally {
    document.removeEventListener('visibilitychange', onVisibility);
  }
  if (!driveAborted) browser.runtime.sendMessage({ type: 'drive:done' }).catch(() => {});
}
