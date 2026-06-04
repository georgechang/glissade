import { spawn } from 'node:child_process';
import { createReadStream } from 'node:fs';
import { readFile, stat, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable, type Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { randomUUID } from 'node:crypto';
import ffmpegStatic from 'ffmpeg-static';
import type { Format } from '@page-capture/shared';
import { CaptureAbortedError, EncodeError } from '../errors';

export type PipeInputFormat =
  | { kind: 'png' }
  | { kind: 'rawvideo'; pixfmt: 'rgb24' | 'rgba'; width: number; height: number };

/**
 * Where the encoded artifact goes. Note: delivery is encode-THEN-drain, not live
 * streaming — MP4 `+faststart` requires a seekable file, so the encoder always
 * finishes to a temp file first. `'writable'` pipes the finished file into your
 * stream; `'stream'` returns a readable of the finished file (its temp is removed
 * on close). For true concurrent upload, add a new variant rather than changing these.
 */
export type OutputTarget =
  | { kind: 'file'; path: string }
  | { kind: 'writable'; stream: NodeJS.WritableStream }
  | { kind: 'buffer' }
  | { kind: 'stream' };

export interface EncodeOptions {
  /** Source frames. PNG buffers for {kind:'png'}; raw pixel buffers for rawvideo. */
  frames: AsyncIterable<Buffer>;
  inputFormat: PipeInputFormat;
  fps: number;
  outWidth: number;
  outHeight: number;
  format: Format;
  crf: number;
  gif: { width: number; fps: number };
  output: OutputTarget;
  /** x264 preset; defaults to 'medium' (good speed/quality for screen content). */
  preset?: string;
  ffmpegPath?: string;
  tempDir?: string;
  signal?: AbortSignal;
  /** Called with the running count of frames piped into ffmpeg. */
  onFrame?: (framesPiped: number) => void;
}

export interface EncodeResult {
  byteLength: number;
  buffer?: Buffer;
  /** Present for output.kind === 'stream'; the temp file is removed on close. */
  stream?: Readable;
}

/** Marks a piping failure that originated from ffmpeg's stdin (vs. the frame source). */
class FfmpegStdinError extends Error {}

function resolveFfmpeg(explicit?: string): string {
  // FFMPEG_BIN is an escape hatch for environments where ffmpeg is on PATH
  // (e.g. the container, where it is apt-installed) — matches the error message.
  const path = explicit ?? process.env.FFMPEG_BIN ?? (ffmpegStatic as string | null);
  if (!path) {
    throw new EncodeError(
      'ffmpeg binary not found. ffmpeg-static returned null on this platform; ' +
        'set runtime.ffmpegPath or the FFMPEG_BIN env var to a valid ffmpeg binary.',
    );
  }
  return path;
}

const makeEven = (n: number): number => {
  const r = Math.floor(n);
  return Math.max(2, r % 2 === 0 ? r : r - 1);
};

/**
 * Scale frames to the exact (even) output dimensions. For image mode this is a
 * no-op; for supersampled URL frames (deviceScaleFactor > 1) it downscales with
 * lanczos for crisp text. (yuv420p is appended only for the MP4 path.)
 */
function scaleFilter(outWidth: number, outHeight: number): string {
  return `scale=${makeEven(outWidth)}:${makeEven(outHeight)}:flags=lanczos`;
}

function inputArgs(fmt: PipeInputFormat, fps: number): string[] {
  if (fmt.kind === 'png') {
    return ['-f', 'image2pipe', '-framerate', String(fps), '-i', '-'];
  }
  return [
    '-f',
    'rawvideo',
    '-pix_fmt',
    fmt.pixfmt,
    '-s',
    `${fmt.width}x${fmt.height}`,
    '-framerate',
    String(fps),
    '-i',
    '-',
  ];
}

/**
 * Write frames to ffmpeg's stdin, honoring backpressure (await 'drain' when
 * write() returns false) and aborting promptly. Rejects on stdin error so the
 * caller doesn't hang; the authoritative failure is ffmpeg's exit code.
 */
async function pipeFrames(
  stdin: Writable,
  frames: AsyncIterable<Buffer>,
  signal: AbortSignal | undefined,
  onFrame: ((n: number) => void) | undefined,
): Promise<void> {
  let n = 0;
  for await (const buf of frames) {
    if (signal?.aborted) throw new CaptureAbortedError();
    if (!stdin.write(buf)) {
      await new Promise<void>((resolve, reject) => {
        const cleanup = (): void => {
          stdin.off('drain', onDrain);
          stdin.off('error', onErr);
          stdin.off('close', onClose);
        };
        const onDrain = (): void => {
          cleanup();
          resolve();
        };
        const onErr = (e: Error): void => {
          cleanup();
          reject(new FfmpegStdinError(e.message));
        };
        const onClose = (): void => {
          cleanup();
          reject(new FfmpegStdinError('ffmpeg stdin closed early'));
        };
        stdin.once('drain', onDrain);
        stdin.once('error', onErr);
        stdin.once('close', onClose);
      });
    }
    onFrame?.(++n);
  }
  stdin.end();
}

/** Run one ffmpeg invocation; optionally pipe frames into its stdin. */
async function runFfmpeg(
  ffmpegPath: string,
  args: string[],
  opts: {
    frames?: AsyncIterable<Buffer>;
    signal?: AbortSignal;
    onFrame?: (n: number) => void;
  } = {},
): Promise<void> {
  const { frames, signal, onFrame } = opts;
  if (signal?.aborted) throw new CaptureAbortedError();

  const child = spawn(ffmpegPath, args, {
    stdio: [frames ? 'pipe' : 'ignore', 'ignore', 'pipe'],
  });

  let stderrTail = '';
  child.stderr?.on('data', (chunk: Buffer) => {
    stderrTail = (stderrTail + chunk.toString()).slice(-8192);
  });

  const onAbort = (): void => {
    child.kill('SIGKILL');
  };
  signal?.addEventListener('abort', onAbort, { once: true });

  const done = new Promise<void>((resolve, reject) => {
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new EncodeError(`ffmpeg exited with code ${code}\n${stderrTail}`));
    });
  });

  let pipeErr: unknown;
  if (frames && child.stdin) {
    child.stdin.on('error', () => {
      /* swallow EPIPE; the real error surfaces via the exit code */
    });
    try {
      await pipeFrames(child.stdin, frames, signal, onFrame);
    } catch (e) {
      pipeErr = e;
    }
  }

  // A frame-source failure (a throw from the generator, not an ffmpeg-side stdin
  // error) leaves ffmpeg blocked on a stdin that was never ended — kill it so the
  // exit settles instead of hanging forever.
  const frameSourceFailed =
    pipeErr !== undefined &&
    !(pipeErr instanceof FfmpegStdinError) &&
    !(pipeErr instanceof CaptureAbortedError);
  if (frameSourceFailed && child.exitCode === null && child.signalCode === null) {
    child.kill('SIGKILL');
  }

  let exitErr: unknown;
  try {
    await done;
  } catch (e) {
    exitErr = e;
  } finally {
    signal?.removeEventListener('abort', onAbort);
  }

  if (signal?.aborted) throw new CaptureAbortedError();
  if (frameSourceFailed) throw pipeErr; // the root cause from the frame source
  if (exitErr) throw exitErr; // ffmpeg's own failure — authoritative (carries stderr)
  if (pipeErr) throw pipeErr; // ffmpeg-side stdin error without a non-zero exit (rare)
}

async function deliver(
  finalPath: string,
  output: OutputTarget,
  cleanupTemps: () => Promise<void>,
): Promise<EncodeResult> {
  switch (output.kind) {
    case 'file': {
      const { size } = await stat(output.path);
      await cleanupTemps();
      return { byteLength: size };
    }
    case 'buffer': {
      const buffer = await readFile(finalPath);
      await cleanupTemps();
      return { byteLength: buffer.length, buffer };
    }
    case 'writable': {
      const { size } = await stat(finalPath);
      await pipeline(createReadStream(finalPath), output.stream as Writable);
      await cleanupTemps();
      return { byteLength: size };
    }
    case 'stream': {
      const { size } = await stat(finalPath);
      const stream = createReadStream(finalPath);
      stream.once('close', () => {
        void unlink(finalPath).catch(() => {});
        void cleanupTemps();
      });
      return { byteLength: size, stream };
    }
  }
}

/**
 * Encode a frame stream into an MP4 (default) or GIF and deliver it to the
 * chosen output target. The MP4 pass always runs first; a GIF is derived from
 * it with a two-pass palette for clean, reasonably-sized scrolling output.
 */
export async function encode(opts: EncodeOptions): Promise<EncodeResult> {
  const ffmpeg = resolveFfmpeg(opts.ffmpegPath);
  const dir = opts.tempDir ?? tmpdir();
  const preset = opts.preset ?? 'medium';
  const temps = new Set<string>();
  const temp = (ext: string): string => {
    const p = join(dir, `pc-${randomUUID()}.${ext}`);
    temps.add(p);
    return p;
  };
  const cleanupTemps = async (): Promise<void> => {
    await Promise.all([...temps].map((p) => unlink(p).catch(() => {})));
    temps.clear();
  };

  const vf = scaleFilter(opts.outWidth, opts.outHeight);
  const frameInput = { frames: opts.frames, signal: opts.signal, onFrame: opts.onFrame };

  try {
    if (opts.format === 'mp4') {
      // Frames -> MP4 (written directly to the destination when possible).
      const mp4Path = opts.output.kind === 'file' ? opts.output.path : temp('mp4');
      await runFfmpeg(
        ffmpeg,
        [
          '-y',
          ...inputArgs(opts.inputFormat, opts.fps),
          '-vf',
          `${vf},format=yuv420p`,
          '-c:v',
          'libx264',
          '-crf',
          String(opts.crf),
          '-preset',
          preset,
          '-movflags',
          '+faststart',
          mp4Path,
        ],
        frameInput,
      );
      return await deliver(mp4Path, opts.output, cleanupTemps);
    }

    // GIF: encode frames ONCE to a lossless FFV1 intermediate (no H.264 artifacts,
    // no yuv420p chroma loss), then derive a clean two-pass palette GIF from it.
    const interPath = temp('mkv');
    await runFfmpeg(
      ffmpeg,
      ['-y', ...inputArgs(opts.inputFormat, opts.fps), '-vf', vf, '-c:v', 'ffv1', interPath],
      frameInput,
    );

    const palettePath = temp('png');
    const gifPath = opts.output.kind === 'file' ? opts.output.path : temp('gif');
    const { width: gw, fps: gfps } = opts.gif;

    await runFfmpeg(ffmpeg, [
      '-y',
      '-i',
      interPath,
      '-vf',
      `fps=${gfps},scale=${gw}:-1:flags=lanczos,palettegen=stats_mode=diff`,
      palettePath,
    ]);

    await runFfmpeg(ffmpeg, [
      '-y',
      '-i',
      interPath,
      '-i',
      palettePath,
      '-lavfi',
      `fps=${gfps},scale=${gw}:-1:flags=lanczos[x];` +
        `[x][1:v]paletteuse=dither=bayer:bayer_scale=5:diff_mode=rectangle`,
      gifPath,
    ]);

    return await deliver(gifPath, opts.output, cleanupTemps);
  } catch (err) {
    await cleanupTemps();
    throw err;
  }
}
