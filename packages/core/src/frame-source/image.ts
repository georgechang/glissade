import sharp from 'sharp';
import type { EasingName, ScrollStop, ScrollStyle } from '@page-capture/shared';
import { CaptureAbortedError, InvalidOptionsError } from '../errors';
import { buildFramePlan } from '../motion';
import type { FrameSourceResult } from './types';

type WarnLogger = { warn?: (...args: unknown[]) => void };

/** Resolve numeric stops (offset/percent) for image/static mode; selectors need a DOM. */
function resolveStaticStops(
  stops: ScrollStop[] | undefined,
  distance: number,
  logger?: WarnLogger,
): Array<{ offset: number; holdMs?: number }> | undefined {
  if (!stops || stops.length === 0) return undefined;
  const out: Array<{ offset: number; holdMs?: number }> = [];
  for (const s of stops) {
    if (s.selector !== undefined) {
      logger?.warn?.(`page-capture: CSS-selector stops are ignored for image/static mode: ${s.selector}`);
      continue;
    }
    const offset = s.offset !== undefined ? s.offset : Math.round(((s.percent as number) / 100) * distance);
    out.push(s.holdMs !== undefined ? { offset, holdMs: s.holdMs } : { offset });
  }
  return out.length ? out : undefined;
}

/** Default cap on decoded source pixels — guards against decompression bombs / OOM. */
const DEFAULT_MAX_SOURCE_PIXELS = 200_000_000;

export interface ImageSourceParams {
  input: { path: string } | { data: Uint8Array };
  outWidth: number;
  outHeight: number;
  fps: number;
  scrollSpeed: number;
  duration?: number;
  minDurationS: number;
  maxDurationS: number;
  holdStartMs: number;
  holdEndMs: number;
  easing: EasingName;
  style?: ScrollStyle;
  roundTrip?: boolean;
  pageHoldMs?: number;
  pageScrollMs?: number;
  pageFraction?: number;
  /** Reading style: explicit pause points (offset/percent; selectors are ignored here). */
  stops?: ScrollStop[];
  logger?: WarnLogger;
  /** Background for letterboxing a short image. Defaults to white. */
  background?: string;
  /** Cap on decoded source pixels (decompression-bomb guard). */
  maxSourcePixels?: number;
  signal?: AbortSignal;
}

function sourceFor(input: ImageSourceParams['input']): string | Buffer {
  return 'path' in input ? input.path : Buffer.from(input.data);
}

/**
 * Image mode: decode the source once at the target width, then pan a fixed
 * viewport window down it. A full-width vertical crop is a contiguous byte run,
 * so each frame is a zero-copy slice of the single decoded buffer.
 */
export async function createImageFrameSource(
  params: ImageSourceParams,
): Promise<FrameSourceResult> {
  const { outWidth, outHeight } = params;
  const background = params.background ?? '#ffffff';
  const src = sourceFor(params.input);

  const { data, info } = await sharp(src, {
    failOn: 'error',
    limitInputPixels: params.maxSourcePixels ?? DEFAULT_MAX_SOURCE_PIXELS,
  })
    .resize({ width: outWidth })
    .flatten({ background })
    .toColourspace('srgb')
    .raw()
    .toBuffer({ resolveWithObject: true });

  const channels = info.channels;
  if (channels !== 3 && channels !== 4) {
    throw new InvalidOptionsError(
      `unsupported image channel count: ${channels} (expected 3 or 4)`,
    );
  }
  const pixfmt = channels === 4 ? 'rgba' : 'rgb24';
  const scaledHeight = info.height;
  const stride = info.width * channels;

  const framePlan = buildFramePlan({
    contentHeight: scaledHeight,
    viewportHeight: outHeight,
    fps: params.fps,
    scrollSpeed: params.scrollSpeed,
    duration: params.duration,
    minDurationS: params.minDurationS,
    maxDurationS: params.maxDurationS,
    holdStartMs: params.holdStartMs,
    holdEndMs: params.holdEndMs,
    easing: params.easing,
    style: params.style,
    roundTrip: params.roundTrip,
    pageHoldMs: params.pageHoldMs,
    pageScrollMs: params.pageScrollMs,
    pageFraction: params.pageFraction,
    stops: resolveStaticStops(params.stops, Math.max(0, scaledHeight - outHeight), params.logger),
  });

  const result: FrameSourceResult = {
    framePlan,
    inputFormat: { kind: 'rawvideo', pixfmt, width: outWidth, height: outHeight },
    outWidth,
    outHeight,
    frames: makeFrames(),
  };
  return result;

  async function* makeFrames(): AsyncIterable<Buffer> {
    if (framePlan.distance <= 0) {
      // Short image: pad into a single static viewport-sized frame, vertically centered.
      const frame = Buffer.alloc(outWidth * outHeight * channels, 0xff);
      const padTopRows = Math.floor((outHeight - scaledHeight) / 2);
      data.copy(frame, padTopRows * stride, 0, scaledHeight * stride);
      for (let i = 0; i < framePlan.totalFrames; i++) {
        yield frame;
      }
      return;
    }

    for (let i = 0; i < framePlan.totalFrames; i++) {
      if (params.signal?.aborted) throw new CaptureAbortedError();
      const top = framePlan.offsetForFrame(i);
      // Zero-copy: contiguous rows [top, top + outHeight) of the decoded buffer.
      yield data.subarray(top * stride, (top + outHeight) * stride);
    }
  }
}
