import { isMessage, type Msg } from '../src/messages';

async function ensureOffscreen(): Promise<void> {
  if (await browser.offscreen.hasDocument()) return;
  await browser.offscreen.createDocument({
    url: 'offscreen.html',
    reasons: [browser.offscreen.Reason.USER_MEDIA],
    justification: 'Encode the captured tab video to MP4.',
  });
}

export default defineBackground(() => {
  // The popup (default action) sends ui:start after the user clicks "Record".
  browser.runtime.onMessage.addListener((raw, _sender, sendResponse) => {
    if (!isMessage(raw) || raw.type !== 'ui:start') return;
    void start(raw.options).then(
      () => sendResponse({ ok: true }),
      (e) => sendResponse({ ok: false, error: String((e as Error)?.message ?? e) }),
    );
    return true; // async sendResponse
  });
});

async function start(options: unknown): Promise<void> {
  const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) throw new Error('no active tab');
  await browser.tabs.setZoom(tab.id, 1).catch(() => undefined); // normalize zoom → crisp 1:1 capture
  const fps = readFps(options);

  // tabCapture stream id for THIS tab (activeTab granted via the toolbar action that opened the popup).
  const streamId = await browser.tabCapture.getMediaStreamId({ targetTabId: tab.id });
  await ensureOffscreen();

  // content script preps the DOM and returns the measured plan.
  const plan = (await browser.tabs.sendMessage(tab.id, { type: 'drive:start', fps, options } satisfies Msg)) as {
    totalFrames: number; width: number; height: number;
  };

  // offscreen begins capturing/encoding…
  await browser.runtime.sendMessage({
    type: 'capture:start', streamId, fps, totalFrames: plan.totalFrames, width: plan.width, height: plan.height,
  } satisfies Msg);

  // …and the content script begins the wall-clock scroll.
  await browser.tabs.sendMessage(tab.id, {
    type: 'capture:start', streamId, fps, totalFrames: plan.totalFrames, width: plan.width, height: plan.height,
  } satisfies Msg);
}

function readFps(options: unknown): number {
  const f = (options as { fps?: unknown }).fps;
  return typeof f === 'number' && f > 0 ? f : 30;
}
