/// <reference types="dom-mediacapture-transform" />
import { Output, Mp4OutputFormat, BufferTarget, CanvasSource, canEncodeVideo } from 'mediabunny';

export interface EncodeParams {
  track: MediaStreamVideoTrack;
  fps: number;
  bitrate?: number;
  signal: AbortSignal;
  /** Aborted when the scroll has finished — the encoder then finalizes what it has. */
  done: AbortSignal;
  onProgress?: (frame: number) => void;
  /** Dynamic cap updated by capture:bound messages; encoder respects the latest value. */
  maxFramesRef?: { current: number };
}
export interface EncodeResult { buffer: ArrayBuffer; encoder: string }

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Read the live tab track, size the canvas from the FIRST captured frame (no dims
 * passed in), and encode on a fixed 1/fps clock. Empty slots duplicate the held
 * frame; bursts are dropped (latest wins). The dynamic maxFramesRef cap is tightened
 * by capture:bound once the scroll plan is known.
 */
export async function encodeTabStream(p: EncodeParams): Promise<EncodeResult> {
  if (p.track.readyState === 'ended') throw new Error('capture track already ended');
  const bitrate = p.bitrate ?? 14_000_000;
  const reader = new MediaStreamTrackProcessor({ track: p.track, maxBufferSize: 1 }).readable.getReader();

  // Read the first non-degenerate frame to seed the canvas dimensions (this is the
  // first frame AFTER capture:go, i.e. the new page at first paint).
  let latest: VideoFrame | null = null;
  const seedDeadline = performance.now() + 3000;
  while (!latest) {
    if (p.signal.aborted) { await reader.cancel().catch(() => {}); p.track.stop(); throw new Error('aborted'); }
    const { value, done } = await reader.read();
    if (done) break;
    if (value.displayWidth > 0 && value.displayHeight > 0) { latest = value; break; }
    value.close();
    if (performance.now() > seedDeadline) break;
  }
  if (!latest) { await reader.cancel().catch(() => {}); p.track.stop(); throw new Error('no capture frame received'); }
  const W = latest.displayWidth & ~1;
  const H = latest.displayHeight & ~1;

  if (!(await canEncodeVideo('avc', { width: W, height: H, bitrate }))) {
    latest.close();
    await reader.cancel().catch(() => {});
    return recordWithMediaRecorder(p);
  }

  const canvas = new OffscreenCanvas(W, H);
  const ctx = canvas.getContext('2d', { alpha: false })!;
  const output = new Output({ format: new Mp4OutputFormat({ fastStart: 'in-memory' }), target: new BufferTarget() });
  const source = new CanvasSource(canvas, { codec: 'avc', bitrate });
  output.addVideoTrack(source, { frameRate: p.fps });
  await output.start();

  // Pump: keep the freshest frame in `latest` (seed is already set).
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
  const FIXED_SAFETY = 600 * p.fps; // 20-min absolute backstop; drive:done + capture:bound are the real stops
  const t0 = performance.now();
  // Stamp each frame with its REAL elapsed time, not n/fps. The loop is paced to
  // ~fps, but if encoding can't sustain fps (e.g. large/HiDPI frames) the loop
  // falls behind real time; using n/fps then compresses the timeline so playback
  // runs faster than the live scroll. Real timestamps keep the output duration ==
  // the actual capture duration (Mediabunny normalizes them to the fps grid).
  let lastStamp = -1;
  try {
    for (let n = 0; ; n++) {
      if (n >= Math.min(p.maxFramesRef?.current ?? FIXED_SAFETY, FIXED_SAFETY)) break;
      if (p.signal.aborted) throw new Error('aborted');
      if (p.done.aborted) break;
      const due = t0 + n * slotMs;
      const wait = due - performance.now();
      if (wait > 0) await sleep(wait);
      if (p.signal.aborted) throw new Error('aborted');
      if (p.done.aborted) break;
      if (latest) ctx.drawImage(latest, 0, 0, W, H);
      const stamp = Math.max((performance.now() - t0) / 1000, lastStamp + slotMs / 4000); // real elapsed, strictly increasing
      lastStamp = stamp;
      await source.add(stamp, 1 / p.fps);
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
 * Robustness floor: when WebCodecs avc encoding is unavailable, record the live
 * track with MediaRecorder. Prefers an MP4/avc1 container when the platform
 * supports it, else WebM/VP9. This path is variable-frame-rate (no CFR reclock)
 * and exists only so the user always gets *a* file. Stops on the done signal; a
 * fixed backstop prevents unbounded recording.
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
  // so end-holds / IPC skew don't truncate the recording.
  const stopAt = performance.now() + 180_000;
  while (!p.signal.aborted && !p.done.aborted && performance.now() < stopAt) await sleep(50);

  if (rec.state !== 'inactive') rec.stop();
  await Promise.race([stopped, sleep(2000)]); // never hang if onstop/onerror never fire
  p.track.stop();

  const blob = new Blob(chunks, { type: isWebm ? 'video/webm' : 'video/mp4' });
  return { buffer: await blob.arrayBuffer(), encoder: isWebm ? 'mediarecorder-webm' : 'mediarecorder-mp4' };
}
