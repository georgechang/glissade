import { EventEmitter } from 'node:events';
import { ZodError } from 'zod';
import {
  CaptureOptionsSchema,
  type CaptureOptions,
  type CaptureOptionsInput,
  type CaptureProgress,
} from '@page-capture/shared';
import type { Browser } from 'playwright-core';
import { CaptureAbortedError, InvalidOptionsError } from './errors';
import { encode, type OutputTarget } from './encode/ffmpeg';
import { createImageFrameSource } from './frame-source/image';
import { createUrlFrameSource } from './frame-source/url';
import type { FrameSourceResult } from './frame-source/types';

export * from '@page-capture/shared';
export * from './errors';
export type { OutputTarget } from './encode/ffmpeg';
export { detectInput, type DetectOptions } from './input';
export { buildFramePlan, getEasing, type FramePlan, type EasingFn } from './motion';

export interface Logger {
  debug: (...args: unknown[]) => void;
  info: (...args: unknown[]) => void;
  warn: (...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
}

const NOOP_LOGGER: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};

export interface CaptureRuntime {
  /** Where the encoded artifact goes. Defaults to an in-memory buffer. */
  output?: OutputTarget;
  /** Silent by default — the core never writes to stdout/stderr itself. */
  logger?: Logger;
  signal?: AbortSignal;
  onProgress?: (p: CaptureProgress) => void;
  /** Host-controlled browser provisioning (URL mode). */
  browserFactory?: () => Promise<Browser>;
  /** SSRF gate run before navigation — throw to deny a URL (e.g. private/metadata hosts). */
  urlPolicy?: (url: URL) => void | Promise<void>;
  /** Override the ffmpeg binary (defaults to the bundled ffmpeg-static). */
  ffmpegPath?: string;
  tempDir?: string;
}

export interface CaptureResult {
  stream?: NodeJS.ReadableStream;
  buffer?: Buffer;
  contentType: string;
  format: 'mp4' | 'gif';
  byteLength: number;
  dimensions: { width: number; height: number };
  frameCount: number;
  durationMs: number;
}

const makeEven = (n: number): number => {
  const r = Math.floor(n);
  return r % 2 === 0 ? r : r - 1;
};

function validate(options: CaptureOptionsInput): CaptureOptions {
  try {
    return CaptureOptionsSchema.parse(options);
  } catch (e) {
    if (e instanceof ZodError) {
      const detail = e.issues
        .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
        .join('; ');
      throw new InvalidOptionsError(`invalid capture options — ${detail}`);
    }
    throw e;
  }
}

async function buildFrameSource(
  opts: CaptureOptions,
  outWidth: number,
  outHeight: number,
  runtime: CaptureRuntime,
): Promise<FrameSourceResult> {
  const motion = {
    fps: opts.fps,
    scrollSpeed: opts.scrollSpeed,
    duration: opts.duration,
    minDurationS: opts.minDurationS,
    maxDurationS: opts.maxDurationS,
    holdStartMs: opts.holds.startMs,
    holdEndMs: opts.holds.endMs,
    easing: opts.easing,
    style: opts.scrollStyle,
    roundTrip: opts.roundTrip,
    pageHoldMs: opts.pageHoldMs,
    pageScrollMs: opts.pageScrollMs,
    pageFraction: opts.pageFraction,
  };

  if (opts.input.kind === 'image') {
    const input = opts.input.path !== undefined
      ? { path: opts.input.path }
      : { data: opts.input.data as Uint8Array };
    return createImageFrameSource({
      input,
      outWidth,
      outHeight,
      ...(opts.limits?.maxSourcePixels !== undefined
        ? { maxSourcePixels: opts.limits.maxSourcePixels }
        : {}),
      ...(opts.stops ? { stops: opts.stops } : {}),
      ...(runtime.logger ? { logger: runtime.logger } : {}),
      ...(runtime.signal ? { signal: runtime.signal } : {}),
      ...motion,
    });
  }

  return createUrlFrameSource({
    url: opts.input.url,
    outWidth,
    outHeight,
    scale: opts.scale,
    mode: opts.urlMode,
    warmup: opts.warmup,
    waitUntil: opts.waits.waitUntil,
    afterLoadMs: opts.waits.afterLoadMs,
    settlePerFrameMs: opts.waits.settlePerFrameMs,
    respectReducedMotion: opts.respectReducedMotion,
    hideFixed: opts.hideFixed,
    maxHeightPx: opts.maxHeightPx,
    ...(opts.waits.selectors ? { selectors: opts.waits.selectors } : {}),
    ...(opts.stops ? { stops: opts.stops } : {}),
    ...(opts.userAgent !== undefined ? { userAgent: opts.userAgent } : {}),
    browserFactory: runtime.browserFactory,
    urlPolicy: runtime.urlPolicy,
    logger: runtime.logger,
    signal: runtime.signal,
    ...motion,
  });
}

/**
 * The single entry point: turn a screenshot or URL into a scrolling MP4/GIF.
 * Host-agnostic — the CLI and the future Azure worker call this identically,
 * differing only in the injected `output` target and `runtime`.
 */
export async function capture(
  options: CaptureOptionsInput,
  runtime: CaptureRuntime = {},
): Promise<CaptureResult> {
  const opts = validate(options);
  const logger = runtime.logger ?? NOOP_LOGGER;
  const output = runtime.output ?? { kind: 'buffer' };
  const { signal, onProgress } = runtime;

  const outWidth = makeEven(opts.size.width);
  const outHeight = makeEven(opts.size.height);

  const emit = (p: CaptureProgress): void => {
    logger.debug('progress', p);
    onProgress?.(p);
  };

  if (signal?.aborted) throw new CaptureAbortedError();

  emit({ phase: 'launch', percent: 0 });
  if (opts.input.kind === 'url') emit({ phase: 'navigate', percent: 2 });

  const source = await buildFrameSource(opts, outWidth, outHeight, runtime);
  const total = source.framePlan.totalFrames;
  emit({ phase: 'settle', percent: 5, framesTotal: total });

  try {
    const result = await encode({
      frames: source.frames,
      inputFormat: source.inputFormat,
      fps: opts.fps,
      outWidth,
      outHeight,
      format: opts.format,
      crf: opts.quality.crf,
      gif: { width: opts.quality.gifWidth, fps: opts.quality.gifFps },
      output,
      ffmpegPath: runtime.ffmpegPath,
      tempDir: runtime.tempDir,
      signal,
      onFrame: (framesDone) => {
        const done = framesDone >= total;
        emit({
          phase: done ? 'encode' : 'capture',
          framesDone,
          framesTotal: total,
          // capture+encode overlap (streaming); reserve the last 10% for finalize.
          percent: Math.min(95, Math.round((framesDone / total) * 90) + 5),
        });
      },
    });

    emit({ phase: 'finalize', percent: 100, framesDone: total, framesTotal: total });

    return {
      ...(result.buffer ? { buffer: result.buffer } : {}),
      ...(result.stream ? { stream: result.stream } : {}),
      byteLength: result.byteLength,
      contentType: opts.format === 'mp4' ? 'video/mp4' : 'image/gif',
      format: opts.format,
      dimensions: { width: outWidth, height: outHeight },
      frameCount: total,
      durationMs: Math.round((total / opts.fps) * 1000),
    };
  } finally {
    await source.dispose?.().catch(() => undefined);
  }
}

/** Class wrapper for callers that want cancellation and progress events. */
export class Capture extends EventEmitter {
  private readonly controller = new AbortController();

  constructor(
    private readonly options: CaptureOptionsInput,
    private readonly runtime: CaptureRuntime = {},
  ) {
    super();
  }

  abort(): void {
    this.controller.abort();
  }

  start(): Promise<CaptureResult> {
    const signals: AbortSignal[] = [this.controller.signal];
    if (this.runtime.signal) signals.push(this.runtime.signal);
    const signal = signals.length > 1 ? AbortSignal.any(signals) : signals[0];

    return capture(this.options, {
      ...this.runtime,
      signal,
      onProgress: (p) => {
        this.emit('progress', p);
        this.runtime.onProgress?.(p);
      },
    });
  }
}
