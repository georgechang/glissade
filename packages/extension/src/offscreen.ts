import { browser } from 'wxt/browser';
import { isMessage, type Msg } from './messages';
import { encodeTabStream, type EncodeParams, type EncodeResult } from './encoder';

let busy = false;
let controller = new AbortController();
let doneController = new AbortController();
let held: { track: MediaStreamVideoTrack; fps: number } | null = null;
const maxFramesRef = { current: 0 };
let abortReason = '';

browser.runtime.onMessage.addListener((raw, _sender, sendResponse) => {
  if (!isMessage(raw)) return;
  if (raw.type === 'abort') { abortReason = raw.reason ?? 'Recording cancelled.'; controller.abort(); return; }
  if (raw.type === 'drive:done') { doneController.abort(); return; }
  if (raw.type === 'capture:bound') { maxFramesRef.current = raw.maxFrames; return; }
  if (raw.type === 'capture:acquire') {
    // Ack only AFTER getUserMedia resolves so the background won't send capture:go
    // (which needs the held track) before the stream exists.
    void acquire(raw).then(() => sendResponse({}), () => sendResponse({}));
    return true; // keep the channel open for the async ack
  }
  if (raw.type === 'capture:go') { void go(); return; }
});

// Phase 1: grab the tab stream now (the streamId is freshest right after the user
// gesture) and hold the track. The track keeps capturing across the page reload that
// the background performs next; we don't start reading frames until GO.
async function acquire(m: Extract<Msg, { type: 'capture:acquire' }>): Promise<void> {
  controller = new AbortController();
  doneController = new AbortController();
  busy = false;
  held = null;
  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      video: { mandatory: { chromeMediaSource: 'tab', chromeMediaSourceId: m.streamId, maxFrameRate: m.fps } } as MediaTrackConstraints,
    });
    const track = stream.getVideoTracks()[0] as MediaStreamVideoTrack;
    track.addEventListener('ended', () => controller.abort());
    held = { track, fps: m.fps };
  } catch (e) {
    held = null;
    browser.runtime.sendMessage({ type: 'capture:done', ok: false, error: `capture: ${(e as Error).message}` } satisfies Msg).catch(() => {});
  }
}

// Phase 2: encode the held track starting from the new page's first paint.
// Canvas dimensions are determined from the first captured frame.
async function go(): Promise<void> {
  if (busy) return;
  if (!held) {
    browser.runtime.sendMessage({ type: 'capture:done', ok: false, error: 'no captured stream (acquire failed?)' } satisfies Msg).catch(() => {});
    return;
  }
  busy = true;
  abortReason = '';
  const { track, fps } = held;
  held = null;
  // Set a generous default cap; tightened later by capture:bound once the plan is known.
  maxFramesRef.current = 180 * fps;
  try {
    const params: EncodeParams = {
      track, fps,
      signal: controller.signal, done: doneController.signal,
      onProgress: (frame) => browser.runtime.sendMessage({ type: 'capture:progress', frame } satisfies Msg).catch(() => {}),
      maxFramesRef,
    };
    const result: EncodeResult = await encodeTabStream(params);
    const { buffer, encoder } = result;
    const ext = encoder.includes('webm') ? 'webm' : 'mp4';
    const blobType = ext === 'webm' ? 'video/webm' : 'video/mp4';
    const url = URL.createObjectURL(new Blob([buffer], { type: blobType }));
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
    browser.runtime.sendMessage({ type: 'capture:done', ok: true, encoder, url, filename: `page-capture.${ext}` } satisfies Msg).catch(() => {});
  } catch (e) {
    const msg = (e as Error).message;
    browser.runtime.sendMessage({ type: 'capture:done', ok: false, error: msg === 'aborted' ? abortReason : msg } satisfies Msg).catch(() => {});
  } finally {
    busy = false;
  }
}
