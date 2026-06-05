/// <reference types="dom-mediacapture-transform" />
import { Output, Mp4OutputFormat, BufferTarget, CanvasSource, canEncodeVideo } from 'mediabunny';
import { GIFEncoder, quantize, applyPalette } from 'gifenc';

export interface EncodeParams {
  track: MediaStreamVideoTrack;
  width: number;
  height: number;
  fps: number;
  totalFrames: number;
  bitrate?: number;
  signal: AbortSignal;
  /** Aborted when the scroll has finished — the encoder then finalizes what it has. */
  done: AbortSignal;
  onProgress?: (frame: number) => void;
  gifFps?: number;
  gifWidth?: number;
}
export interface EncodeResult { buffer: ArrayBuffer; encoder: string }

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Read the live tab track, and on a fixed 1/fps clock draw the latest received
 * frame to a canvas and add it to the muxer with an exact CFR timestamp.
 * Empty slots duplicate the held frame; bursts are dropped (latest wins) — the
 * real-time realisation of buildSampleSchedule.
 */
export async function encodeTabStream(p: EncodeParams): Promise<EncodeResult> {
  const bitrate = p.bitrate ?? 14_000_000;
  if (p.track.readyState === 'ended') throw new Error('capture track already ended');
  if (!(await canEncodeVideo('avc', { width: p.width, height: p.height, bitrate }))) {
    return recordWithMediaRecorder(p);
  }
  const canvas = new OffscreenCanvas(p.width, p.height);
  const ctx = canvas.getContext('2d', { alpha: false })!;
  const output = new Output({ format: new Mp4OutputFormat({ fastStart: 'in-memory' }), target: new BufferTarget() });
  const source = new CanvasSource(canvas, { codec: 'avc', bitrate });
  output.addVideoTrack(source, { frameRate: p.fps });
  await output.start();

  const reader = (new MediaStreamTrackProcessor({ track: p.track }).readable).getReader();
  let latest: VideoFrame | null = null;
  let reading = true;
  const pump = (async () => {
    try {
      while (reading) {
        const { value, done } = await reader.read();
        if (done) break;
        latest?.close();
        latest = value;
      }
    } finally {
      latest?.close();
      latest = null;
    }
  })();

  const slotMs = 1000 / p.fps;
  const t0 = performance.now();
  // Record on the fixed grid until the scroll signals completion (p.done), or abort,
  // or a safety cap (never run more than ~2s past the planned length). Stopping on the
  // scroll-done signal — not a fixed frame count — guarantees the whole scroll (incl.
  // its end-hold/tail) is captured even though the encoder clock starts slightly early.
  const hardCap = p.totalFrames + Math.ceil(p.fps * 2);
  try {
    for (let n = 0; n < hardCap; n++) {
      if (p.signal.aborted) throw new Error('aborted');
      if (p.done.aborted) break;
      const due = t0 + n * slotMs;
      const wait = due - performance.now();
      if (wait > 0) await sleep(wait);
      if (p.signal.aborted) throw new Error('aborted');
      if (p.done.aborted) break;
      if (latest) ctx.drawImage(latest, 0, 0, p.width, p.height);
      await source.add(n / p.fps, 1 / p.fps);
      p.onProgress?.(n + 1);
    }
  } finally {
    reading = false;
    reader.cancel().catch(() => undefined);
    await pump.catch(() => undefined);
    (latest as VideoFrame | null)?.close();
    p.track.stop();
  }
  await output.finalize();
  return { buffer: output.target.buffer!, encoder: 'webcodecs-avc' };
}

/**
 * GIF output: the same live-frame CFR sampling as the MP4 path, but at the lower
 * gifFps, drawn to a downscaled canvas and palette-quantized per frame. Stops on the
 * scroll `done` signal (like the MP4 path). GIFs are large / 256-colour — an
 * alternative, not the default.
 */
export async function encodeTabStreamToGif(p: EncodeParams): Promise<EncodeResult> {
  if (p.track.readyState === 'ended') throw new Error('capture track already ended');
  const gifFps = p.gifFps ?? 15;
  const gifW = p.gifWidth ?? 640;
  const gifH = Math.max(2, Math.round((p.height / p.width) * gifW));
  const canvas = new OffscreenCanvas(gifW, gifH);
  const ctx = canvas.getContext('2d', { alpha: false, willReadFrequently: true })!;
  const gif = GIFEncoder();
  const delay = Math.round(1000 / gifFps);

  const reader = (new MediaStreamTrackProcessor({ track: p.track }).readable).getReader();
  let latest: VideoFrame | null = null;
  let reading = true;
  const pump = (async () => {
    try {
      while (reading) {
        const { value, done } = await reader.read();
        if (done) break;
        latest?.close();
        latest = value;
      }
    } finally {
      latest?.close();
      latest = null;
    }
  })();

  const slotMs = 1000 / gifFps;
  const durationS = p.totalFrames / p.fps;             // the scroll's wall-clock length
  const hardCap = Math.ceil(durationS * gifFps) + Math.ceil(gifFps * 2);
  const t0 = performance.now();
  try {
    for (let n = 0; n < hardCap; n++) {
      if (p.signal.aborted) throw new Error('aborted');
      if (p.done.aborted) break;
      const due = t0 + n * slotMs;
      const wait = due - performance.now();
      if (wait > 0) await sleep(wait);
      if (p.signal.aborted) throw new Error('aborted');
      if (p.done.aborted) break;
      if (latest) ctx.drawImage(latest, 0, 0, gifW, gifH);
      const { data } = ctx.getImageData(0, 0, gifW, gifH);
      const rgba = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
      const palette = quantize(rgba, 256);
      const index = applyPalette(rgba, palette);
      gif.writeFrame(index, gifW, gifH, { palette, delay });
      p.onProgress?.(n + 1);
    }
  } finally {
    reading = false;
    reader.cancel().catch(() => undefined);
    await pump.catch(() => undefined);
    (latest as VideoFrame | null)?.close();
    p.track.stop();
  }
  gif.finish();
  const out = gif.bytes();
  return { buffer: out.slice().buffer, encoder: 'gif' };
}

/**
 * Robustness floor: when WebCodecs avc encoding is unavailable, record the live
 * track with MediaRecorder. Prefers an MP4/avc1 container when the platform
 * supports it, else WebM/VP9. This path is variable-frame-rate (no CFR reclock)
 * and exists only so the user always gets *a* file. Stops after the planned
 * duration (totalFrames / fps) or on abort.
 */
async function recordWithMediaRecorder(p: EncodeParams): Promise<EncodeResult> {
  const MP4 = 'video/mp4;codecs=avc1.42E01E';
  const WEBM = 'video/webm;codecs=vp9';
  const mimeType = MediaRecorder.isTypeSupported(MP4) ? MP4 : WEBM;
  const isWebm = mimeType.startsWith('video/webm');

  const stream = new MediaStream([p.track]);
  const rec = new MediaRecorder(stream, { mimeType });
  const chunks: Blob[] = [];
  rec.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
  const stopped = new Promise<void>((resolve) => {
    rec.onstop = () => resolve();
    rec.onerror = () => resolve();
  });
  rec.start(1000); // 1s timeslices keep memory bounded for long captures

  // Primary stop is the scroll-done signal (p.done); this time cap is only a backstop
  // (+3s) so end-holds / IPC skew don't truncate the recording.
  const stopAt = performance.now() + (p.totalFrames / p.fps) * 1000 + 3000;
  while (!p.signal.aborted && !p.done.aborted && performance.now() < stopAt) await sleep(50);

  if (rec.state !== 'inactive') rec.stop();
  await Promise.race([stopped, sleep(2000)]); // never hang if onstop/onerror never fire
  p.track.stop();

  const blob = new Blob(chunks, { type: isWebm ? 'video/webm' : 'video/mp4' });
  return { buffer: await blob.arrayBuffer(), encoder: isWebm ? 'mediarecorder-webm' : 'mediarecorder-mp4' };
}
