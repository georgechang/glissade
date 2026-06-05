import { isMessage, type Msg } from '../src/messages';
import { CaptureOptionsSchema } from '@page-capture/shared';

let activeTabId: number | undefined;

async function ensureOffscreen(): Promise<void> {
  if (await browser.offscreen.hasDocument()) return;
  await browser.offscreen.createDocument({
    url: 'offscreen.html',
    reasons: [browser.offscreen.Reason.USER_MEDIA],
    justification: 'Encode the captured tab video to MP4.',
  });
}

/**
 * Wait for the new page's first paint, signalled by a `page:firstPaint` message from
 * the content script. Chrome "Paint Holding" keeps the OLD page's pixels on the
 * captured surface until the new document's first paint — so recording must be gated
 * on this event, not on document_start itself.
 */
function awaitFirstPaint(tabId: number, timeoutMs = 10_000): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (err?: Error) => {
      if (settled) return;
      settled = true;
      browser.runtime.onMessage.removeListener(onMsg);
      err ? reject(err) : resolve();
    };
    const onMsg = (msg: unknown, sender: { tab?: { id?: number } }) => {
      if (isMessage(msg) && msg.type === 'page:firstPaint' && sender?.tab?.id === tabId) finish();
    };
    browser.runtime.onMessage.addListener(onMsg);
    setTimeout(() => finish(new Error('timed out waiting for page first paint')), timeoutMs);
  });
}

/**
 * Await the tab reaching 'complete', bounded by capMs so entrance animations aren't
 * held hostage by a stalled load. If the tab is already complete, resolves immediately.
 */
async function awaitCompleteBounded(tabId: number, capMs: number): Promise<void> {
  try {
    const t = await browser.tabs.get(tabId);
    if (t.status === 'complete') return;
  } catch { /* ignore */ }
  let onUpdated: ((id: number, info: { status?: string }) => void) | undefined;
  await Promise.race([
    new Promise<void>((resolve) => {
      onUpdated = (id, info) => {
        if (id === tabId && info.status === 'complete') resolve();
      };
      browser.tabs.onUpdated.addListener(onUpdated);
    }),
    new Promise<void>((r) => setTimeout(r, capMs)),
  ]);
  if (onUpdated) browser.tabs.onUpdated.removeListener(onUpdated);
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

  // 2) Reload the tab so scroll-triggered animations re-arm.
  await browser.tabs.reload(tab.id);
  // 3) Gate on the new page's first paint (Chrome Paint Holding has ended by now).
  await awaitFirstPaint(tab.id);                                            // new page's first paint
  // 4) Start recording NOW — entrance/on-load animations are captured from here.
  await browser.runtime.sendMessage({ type: 'capture:go' } satisfies Msg);
  // 5) Record entrance animations + load as the intro; cap so stalled load can't bloat it.
  await awaitCompleteBounded(tab.id, 2500);

  // 6) Content preps DOM, measures plan, returns {totalFrames, width, height}.
  const plan = await sendToTab<{ totalFrames: number; width: number; height: number }>(
    tab.id, { type: 'drive:start', fps, options } satisfies Msg);

  // 7) Tighten the encoder's runaway cap and tell the popup the total frame count.
  const maxFrames = plan.totalFrames + Math.ceil(15 * fps); // backstop only; drive:done is authoritative
  await browser.runtime.sendMessage({ type: 'capture:bound', maxFrames } satisfies Msg);
  browser.runtime.sendMessage({ type: 'progress:total', totalFrames: plan.totalFrames } satisfies Msg).catch(() => {});

  // 8) Content holds the top for pageHoldMs (built into the plan) then scrolls.
  await sendToTab(tab.id, { type: 'scroll:start', fps } satisfies Msg);
}
