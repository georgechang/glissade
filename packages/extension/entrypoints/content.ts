import { CaptureOptionsSchema } from '@page-capture/shared';
import {
  buildFramePlan, frameAtElapsed, dismissConsent, hideFixedElements,
  measureStableHeight, neutralizeLazyImages, resolveStops,
} from '@page-capture/scroll-engine';
import { isMessage } from '../src/messages';

let lastPlan: { totalFrames: number; offsetForFrame: (i: number) => number } | null = null;

export default defineContentScript({
  matches: ['http://*/*', 'https://*/*'],
  registration: 'manifest',
  runAt: 'document_idle',
  main() {
    // drive:start → prep DOM + measure the plan, respond with {totalFrames,width,height}
    browser.runtime.onMessage.addListener((raw, _sender, sendResponse) => {
      if (!isMessage(raw) || raw.type !== 'drive:start') return;
      void prepareAndReportPlan(raw.fps, raw.options).then(sendResponse);
      return true; // async sendResponse
    });
    // capture:start → run the wall-clock scroll
    browser.runtime.onMessage.addListener((raw) => {
      if (isMessage(raw) && raw.type === 'capture:start' && lastPlan) void drive(raw.fps, lastPlan);
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
    holdStartMs: opts.holds.startMs, holdEndMs: opts.holds.endMs, easing: opts.easing,
    style: opts.scrollStyle, roundTrip: opts.roundTrip,
    pageHoldMs: opts.pageHoldMs, pageScrollMs: opts.pageScrollMs, pageFraction: opts.pageFraction,
    ...(stops ? { stops } : {}),
  });
  lastPlan = { totalFrames: plan.totalFrames, offsetForFrame: plan.offsetForFrame };
  return { totalFrames: plan.totalFrames, width: window.innerWidth, height: viewportHeight };
}

async function drive(fps: number, plan: { totalFrames: number; offsetForFrame: (i: number) => number }) {
  window.scrollTo(0, 0);
  await new Promise((r) => requestAnimationFrame(() => r(undefined)));
  const t0 = performance.now();
  await new Promise<void>((resolve) => {
    const tick = () => {
      const frame = frameAtElapsed(performance.now() - t0, fps, plan.totalFrames);
      window.scrollTo(0, plan.offsetForFrame(frame));
      browser.runtime.sendMessage({ type: 'drive:progress', frame, totalFrames: plan.totalFrames }).catch(() => {});
      if (frame >= plan.totalFrames - 1) { resolve(); return; }
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
  browser.runtime.sendMessage({ type: 'drive:done' }).catch(() => {});
}
