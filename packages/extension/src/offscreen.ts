import { browser } from 'wxt/browser';
import { isMessage, type Msg } from './messages';
import { encodeTabStream } from './encoder';

let busy = false;
let controller = new AbortController();

browser.runtime.onMessage.addListener((raw) => {
  if (!isMessage(raw)) return;
  if (raw.type === 'abort') { controller.abort(); return; }
  if (raw.type !== 'capture:start') return;
  void run(raw);
});

async function run(m: Extract<Msg, { type: 'capture:start' }>): Promise<void> {
  if (busy) return;
  busy = true;
  controller = new AbortController();
  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      video: { mandatory: { chromeMediaSource: 'tab', chromeMediaSourceId: m.streamId,
        maxWidth: m.width, maxHeight: m.height, maxFrameRate: m.fps } } as MediaTrackConstraints,
    });
    const track = stream.getVideoTracks()[0] as MediaStreamVideoTrack;
    const { buffer, encoder } = await encodeTabStream({
      track, width: m.width, height: m.height, fps: m.fps, totalFrames: m.totalFrames,
      signal: controller.signal,
      onProgress: (frame) => browser.runtime.sendMessage({ type: 'capture:progress', frame, totalFrames: m.totalFrames } satisfies Msg).catch(() => {}),
    });
    const isWebm = encoder.includes('webm');
    const blobType = isWebm ? 'video/webm' : 'video/mp4';
    const filename = isWebm ? 'page-capture.webm' : 'page-capture.mp4';
    const url = URL.createObjectURL(new Blob([buffer], { type: blobType }));
    try {
      await browser.downloads.download({ url, filename, saveAs: true });
    } finally {
      URL.revokeObjectURL(url);
    }
    browser.runtime.sendMessage({ type: 'capture:done', ok: true, encoder } satisfies Msg).catch(() => {});
  } catch (e) {
    browser.runtime.sendMessage({ type: 'capture:done', ok: false, error: (e as Error).message } satisfies Msg).catch(() => {});
  } finally {
    busy = false;
  }
}
