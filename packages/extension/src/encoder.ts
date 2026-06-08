/// <reference types="dom-mediacapture-transform" />
import { Output, Mp4OutputFormat, BufferTarget, MediaStreamVideoTrackSource, canEncodeVideo } from 'mediabunny';

export interface EncodeParams {
  track: MediaStreamVideoTrack;
  fps: number;
  bitrate?: number;
  signal: AbortSignal;
  /** Aborted when the scroll has finished — the encoder then finalizes what it has. */
  done: AbortSignal;
  /** Legacy frame cap (capture:bound); unused by the track-source path, kept for the message protocol. */
  maxFramesRef?: { current: number };
}
export interface EncodeResult { buffer: ArrayBuffer; encoder: string }

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Encode the live tab track to H.264 MP4. Mediabunny's MediaStreamVideoTrackSource
 * pulls VideoFrames straight off the track into the encoder — no OffscreenCanvas
 * round-trip (drawImage + recapture), and no separate setTimeout pacing loop whose
 * clock beat against the capture cadence and produced duplicated/skipped frames. The
 * source samples the track at `fps` and the muxer snaps timestamps to that CFR grid
 * (frameRate metadata), so output duration tracks real capture time and static holds
 * extend the last frame. Stops on the scroll-done signal; a long backstop guards a
 * lost done message. Falls back to MediaRecorder when WebCodecs AVC is unavailable.
 */
export async function encodeTabStream(p: EncodeParams): Promise<EncodeResult> {
  if (p.track.readyState === 'ended') throw new Error('capture track already ended');
  const bitrate = p.bitrate ?? 14_000_000;

  // Dimensions come from the track's settings (it has been capturing since acquire).
  // H.264 needs even dimensions, so round down. If settings are unavailable the
  // canEncodeVideo check below fails and we fall back to MediaRecorder.
  const settings = p.track.getSettings();
  const W = (settings.width ?? 0) & ~1;
  const H = (settings.height ?? 0) & ~1;

  // Configure the encoder for live capture, not offline quality. latencyMode is the
  // key smoothness lever: the default 'quality' buffers/reorders frames and never
  // drops any, deepening the encoder queue until the source can't keep up with the
  // live frame rate — Mediabunny then duplicates frames onto the CFR grid and the
  // scroll judders. 'realtime' keeps the encoder shallow so throughput tracks fps.
  // prefer-hardware (a big win at 2x DPR) is tried first, then no-preference, then
  // MediaRecorder — HW-less machines still record. The support check carries the same
  // hints so a config that passes here can't fail at start().
  const base = { width: W, height: H, bitrate, latencyMode: 'realtime' as const };
  let hardwareAcceleration: 'prefer-hardware' | 'no-preference' | undefined;
  if (W >= 2 && H >= 2) {
    if (await canEncodeVideo('avc', { ...base, hardwareAcceleration: 'prefer-hardware' })) hardwareAcceleration = 'prefer-hardware';
    else if (await canEncodeVideo('avc', { ...base, hardwareAcceleration: 'no-preference' })) hardwareAcceleration = 'no-preference';
  }
  if (hardwareAcceleration === undefined) return recordWithMediaRecorder(p);

  // Resize to even dimensions only when the source is actually odd (rare); otherwise
  // frames reach the encoder untouched — no per-frame resize pass.
  const odd = (settings.width ?? W) !== W || (settings.height ?? H) !== H;
  const output = new Output({ format: new Mp4OutputFormat({ fastStart: 'in-memory' }), target: new BufferTarget() });
  const source = new MediaStreamVideoTrackSource(
    p.track,
    { codec: 'avc', bitrate, latencyMode: 'realtime', hardwareAcceleration,
      ...(odd ? { transform: { width: W, height: H } } : {}) },
    { frameRate: p.fps },
  );
  output.addVideoTrack(source, { frameRate: p.fps });

  // errorPromise never resolves; it rejects on an internal source error. Carry the
  // error in the resolved value so it can lose/win the stop race below without hanging.
  type Stop = 'done' | 'abort' | { error: Error };
  const errored: Promise<Stop> = source.errorPromise.then(
    () => ({ error: new Error('encoder error') }),
    (e: unknown) => ({ error: e instanceof Error ? e : new Error(String(e)) }),
  );

  await output.start();

  // Run until the scroll finishes (done), the user aborts, the source errors, or the
  // backstop trips. No frame-count cap and no pacing loop: the source paces itself off
  // the track and the muxer enforces CFR.
  const onAbort = (sig: AbortSignal, tag: 'done' | 'abort'): Promise<Stop> =>
    new Promise((res) => {
      if (sig.aborted) res(tag);
      else sig.addEventListener('abort', () => res(tag), { once: true });
    });
  let backstopId: ReturnType<typeof setTimeout>;
  const backstop: Promise<Stop> = new Promise((res) => { backstopId = setTimeout(() => res('done'), 20 * 60 * 1000); });
  const reason = await Promise.race([onAbort(p.done, 'done'), onAbort(p.signal, 'abort'), errored, backstop]);
  clearTimeout(backstopId!);

  if (reason !== 'done') {
    await output.cancel().catch(() => {});
    p.track.stop();
    throw reason === 'abort' ? new Error('aborted') : reason.error;
  }

  source.pause(); // stop pulling frames, then flush the encoder
  await output.finalize();
  p.track.stop();
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
