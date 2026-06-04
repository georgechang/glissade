/// <reference types="dom-mediacapture-transform" />
import { Output, Mp4OutputFormat, BufferTarget, CanvasSource, canEncodeVideo } from 'mediabunny';

export interface EncodeParams {
  track: MediaStreamVideoTrack;
  width: number;
  height: number;
  fps: number;
  totalFrames: number;
  bitrate?: number;
  signal: AbortSignal;
  onProgress?: (frame: number) => void;
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
    throw new Error('H.264 (avc) encoding not supported on this machine');
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
  try {
    for (let n = 0; n < p.totalFrames; n++) {
      if (p.signal.aborted) throw new Error('aborted');
      const due = t0 + n * slotMs;
      const wait = due - performance.now();
      if (wait > 0) await sleep(wait);
      if (p.signal.aborted) throw new Error('aborted');
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
