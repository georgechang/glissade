import { extname } from 'node:path';
import { detectInput, InvalidOptionsError } from '@page-capture/core';
import type {
  CaptureOptionsInput,
  EasingName,
  Format,
  ScrollStop,
  ScrollStyle,
  UrlMode,
  WaitUntil,
  WarmupMode,
} from '@page-capture/shared';

export interface CliFlags {
  type?: 'url' | 'image';
  format?: Format;
  output?: string;
  width?: number;
  height?: number;
  fps?: number;
  scale?: number;
  duration?: number;
  velocity?: number;
  easing?: EasingName;
  scrollStyle?: ScrollStyle;
  roundTrip?: boolean;
  pageHold?: number;
  pageScroll?: number;
  pageFraction?: number;
  minDuration?: number;
  maxDuration?: number;
  holdStart?: number;
  holdEnd?: number;
  mode?: UrlMode;
  warmup?: WarmupMode;
  userAgent?: string;
  waitUntil?: WaitUntil;
  wait?: number;
  settlePerFrame?: number;
  selector?: string[];
  respectReducedMotion?: boolean;
  hideFixed?: boolean;
  maxHeight?: number;
  crf?: number;
  gifWidth?: number;
  gifFps?: number;
}

function inferFormatFromPath(path?: string): Format | undefined {
  if (!path) return undefined;
  const ext = extname(path).toLowerCase();
  if (ext === '.gif') return 'gif';
  if (ext === '.mp4') return 'mp4';
  return undefined;
}

/** Resolve the output format (explicit --format wins over the file extension). */
export function resolveFormat(flags: CliFlags): Format {
  return flags.format ?? inferFormatFromPath(flags.output) ?? 'mp4';
}

/**
 * Map parsed CLI flags onto a (schema-valid) CaptureOptions object. Undefined
 * fields are left out so the shared schema fills in defaults.
 */
export function toCaptureOptions(
  rawInput: string,
  flags: CliFlags,
): { options: CaptureOptionsInput; outputPath: string; format: Format } {
  const input = detectInput(rawInput, flags.type ? { type: flags.type } : {});
  const format = resolveFormat(flags);
  const outputPath = flags.output ?? `capture.${format}`;

  const options: CaptureOptionsInput = {
    input,
    format,
    size: { width: flags.width, height: flags.height },
    fps: flags.fps,
    scale: flags.scale,
    duration: flags.duration,
    scrollSpeed: flags.velocity,
    easing: flags.easing,
    scrollStyle: flags.scrollStyle,
    roundTrip: flags.roundTrip,
    pageHoldMs: flags.pageHold,
    pageScrollMs: flags.pageScroll,
    pageFraction: flags.pageFraction,
    minDurationS: flags.minDuration,
    maxDurationS: flags.maxDuration,
    holds: { startMs: flags.holdStart, endMs: flags.holdEnd },
    urlMode: flags.mode,
    warmup: flags.warmup,
    userAgent: flags.userAgent,
    waits: {
      afterLoadMs: flags.wait,
      settlePerFrameMs: flags.settlePerFrame,
      waitUntil: flags.waitUntil,
      selectors: flags.selector,
    },
    respectReducedMotion: flags.respectReducedMotion,
    hideFixed: flags.hideFixed,
    maxHeightPx: flags.maxHeight,
    quality: { crf: flags.crf, gifWidth: flags.gifWidth, gifFps: flags.gifFps },
  };

  return { options, outputPath, format };
}

/**
 * Parse the inline --stops form into structured stops. Comma-separated tokens,
 * each one of: a CSS selector, a pixel offset (`640` or `640px`), or a percent
 * (`66%`), with an optional `@<ms>` per-stop hold. e.g. "#hero@2000, 1200, 66%, footer".
 */
export function parseStopsString(input: string): ScrollStop[] {
  return input
    .split(',')
    .map((t) => t.trim())
    .filter((t) => t.length > 0)
    .map(parseStopToken);
}

function parseStopToken(token: string): ScrollStop {
  let base = token;
  let holdMs: number | undefined;
  const at = token.lastIndexOf('@');
  if (at > 0) {
    const n = Number(token.slice(at + 1).trim());
    if (!Number.isFinite(n) || n < 0) {
      throw new InvalidOptionsError(`invalid hold duration in stop "${token}"`);
    }
    holdMs = n;
    base = token.slice(0, at).trim();
  }
  const hold = holdMs !== undefined ? { holdMs } : {};
  if (/^\d+(\.\d+)?%$/.test(base)) return { percent: parseFloat(base), ...hold };
  const px = base.replace(/px$/i, '');
  if (/^\d+(\.\d+)?$/.test(px)) return { offset: parseFloat(px), ...hold };
  if (base.length === 0) throw new InvalidOptionsError(`empty stop in "${token}"`);
  return { selector: base, ...hold };
}
