import { isMessage, type Msg } from '../src/messages';
import { CaptureOptionsSchema } from '@page-capture/shared';

let activeTabId: number | undefined;

async function ensureOffscreen(): Promise<void> {
  if (await browser.offscreen.hasDocument()) return;
  await browser.offscreen.createDocument({
    url: 'offscreen.html',
    reasons: [browser.offscreen.Reason.USER_MEDIA],
    justification: 'Encode the captured tab video to MP4/GIF.',
  });
}

/** Reload the tab and resolve once it has finished loading (+ a short settle so the
 *  freshly-injected content script is listening and fonts/lazy content have settled). */
async function reloadAndWait(tabId: number): Promise<void> {
  await new Promise<void>((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      browser.tabs.onUpdated.removeListener(onUpdated);
      resolve();
    };
    const onUpdated = (id: number, info: { status?: string }) => {
      if (id === tabId && info.status === 'complete') finish();
    };
    browser.tabs.onUpdated.addListener(onUpdated); // attach BEFORE reload to avoid missing 'complete'
    setTimeout(finish, 30_000); // safety: never hang waiting for load
    browser.tabs.reload(tabId).catch(finish);
  });
  await new Promise((r) => setTimeout(r, 800));
}

/** Send a message to the tab's content script, retrying briefly while it (re)injects. */
async function sendToTab<T>(tabId: number, msg: Msg, retries = 6): Promise<T> {
  for (let i = 0; ; i++) {
    try {
      return (await browser.tabs.sendMessage(tabId, msg)) as T;
    } catch (e) {
      if (i >= retries) throw e;
      await new Promise((r) => setTimeout(r, 300));
    }
  }
}

export default defineBackground(() => {
  // The popup sends ui:start after the user clicks "Record".
  browser.runtime.onMessage.addListener((raw, _sender, sendResponse) => {
    if (!isMessage(raw) || raw.type !== 'ui:start') return;
    void start(raw.options).then(
      () => sendResponse({ ok: true }),
      (e) => sendResponse({ ok: false, error: String((e as Error)?.message ?? e) }),
    );
    return true; // async sendResponse
  });
  // The offscreen has no chrome.downloads — it hands us the blob URL to save.
  // On failure → stop the (now pointless) scroll in the content tab.
  browser.runtime.onMessage.addListener((raw) => {
    if (!isMessage(raw) || raw.type !== 'capture:done') return;
    if (raw.ok) {
      browser.downloads.download({ url: raw.url, filename: raw.filename, saveAs: true }).catch(() => {});
    } else if (activeTabId !== undefined) {
      browser.tabs.sendMessage(activeTabId, { type: 'abort' } satisfies Msg).catch(() => {});
    }
  });
});

async function start(options: unknown): Promise<void> {
  const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) throw new Error('no active tab');
  activeTabId = tab.id;
  const opts = CaptureOptionsSchema.parse(options);
  const fps = opts.fps;

  await browser.tabs.setZoom(tab.id, 1).catch(() => undefined); // normalize zoom → crisp 1:1 capture

  // 1) Acquire the tab stream NOW, while the gesture/activeTab is fresh; the offscreen
  //    holds the track across the reload.
  const streamId = await browser.tabCapture.getMediaStreamId({ targetTabId: tab.id });
  await ensureOffscreen();
  await browser.runtime.sendMessage({ type: 'capture:acquire', streamId, fps } satisfies Msg);

  // 2) Reload so scroll-triggered animations re-arm; wait for load (skippable).
  if (opts.reloadBeforeCapture) await reloadAndWait(tab.id);

  // 3) Content preps the freshly-loaded page and returns the measured plan.
  const plan = await sendToTab<{ totalFrames: number; width: number; height: number }>(
    tab.id, { type: 'drive:start', fps, options } satisfies Msg);

  // 4) Offscreen encodes the held track…
  await browser.runtime.sendMessage({
    type: 'capture:go',
    totalFrames: plan.totalFrames, width: plan.width, height: plan.height,
    format: opts.format,
    ...(opts.format === 'gif' ? { gifWidth: opts.quality.gifWidth, gifFps: opts.quality.gifFps } : {}),
  } satisfies Msg);

  // 5) …and the content script scrolls.
  await sendToTab(tab.id, { type: 'scroll:start', fps } satisfies Msg);
}
