import { browser } from 'wxt/browser';
import { isMessage, type Msg } from './messages';
import { encodeTabStream } from './encoder';

const controller = { abort: new AbortController() };

browser.runtime.onMessage.addListener((raw) => {
  if (!isMessage(raw)) return;
  if (raw.type === 'abort') { controller.abort.abort(); return; }
  if (raw.type !== 'capture:start') return;
  void run(raw);
});

async function run(m: Extract<Msg, { type: 'capture:start' }>): Promise<void> {
  controller.abort = new AbortController();
  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      video: { mandatory: { chromeMediaSource: 'tab', chromeMediaSourceId: m.streamId,
        maxWidth: m.width, maxHeight: m.height, maxFrameRate: m.fps } } as MediaTrackConstraints,
    });
    const track = stream.getVideoTracks()[0] as MediaStreamVideoTrack;
    const { buffer, encoder } = await encodeTabStream({
      track, width: m.width, height: m.height, fps: m.fps, totalFrames: m.totalFrames,
      signal: controller.abort.signal,
      onProgress: (frame) => browser.runtime.sendMessage({ type: 'capture:progress', frame, totalFrames: m.totalFrames } satisfies Msg),
    });
    const url = URL.createObjectURL(new Blob([buffer], { type: 'video/mp4' }));
    await browser.downloads.download({ url, filename: 'page-capture.mp4', saveAs: true });
    browser.runtime.sendMessage({ type: 'capture:done', ok: true, encoder } satisfies Msg);
  } catch (e) {
    browser.runtime.sendMessage({ type: 'capture:done', ok: false, error: (e as Error).message } satisfies Msg);
  }
}
