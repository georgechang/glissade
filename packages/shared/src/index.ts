import { z } from 'zod';

/**
 * @page-capture/shared — the framework-agnostic contracts shared by every surface
 * (the core engine, the CLI, and the future web API / worker / SPA).
 *
 * A `CaptureOptions` value is the fully-serializable description of *what to
 * capture*. It deliberately contains no Node streams, sockets, or callbacks —
 * those are runtime concerns carried separately (see `CaptureRuntime` in core),
 * which is what lets the identical request travel from a web form, through a
 * queue message, to a worker, unchanged.
 */

export const FORMATS = ['mp4', 'gif'] as const;
export type Format = (typeof FORMATS)[number];

export const EASINGS = [
  'linear',
  'easeIn',
  'easeOut',
  'easeInOut',
  'easeInOutSine',
  'smoothstep',
] as const;
export type EasingName = (typeof EASINGS)[number];

export const URL_MODES = ['animate', 'static'] as const;
export type UrlMode = (typeof URL_MODES)[number];

// 'images': load lazy media in place WITHOUT scrolling (keeps scroll reveals armed);
// 'none': record cold; 'full': pre-scroll to force-load all (consumes once-only reveals).
export const WARMUP_MODES = ['images', 'none', 'full'] as const;
export type WarmupMode = (typeof WARMUP_MODES)[number];

export const WAIT_UNTIL = ['load', 'domcontentloaded', 'networkidle'] as const;
export type WaitUntil = (typeof WAIT_UNTIL)[number];

export const SCROLL_STYLES = ['reading', 'continuous'] as const;
export type ScrollStyle = (typeof SCROLL_STYLES)[number];

export const CAPTURE_PHASES = [
  'launch',
  'navigate',
  'settle',
  'capture',
  'encode',
  'finalize',
] as const;
export type CapturePhase = (typeof CAPTURE_PHASES)[number];

/** Default values shared by the CLI and the future web form. */
export const DEFAULTS = {
  width: 1920,
  height: 1080,
  fps: 30,
  // deviceScaleFactor. 1 = output dims == CSS layout width (true desktop layout).
  // >1 supersamples (renders at scale×, downscaled to output) for crisper text.
  scale: 1,
  format: 'mp4',
  easing: 'easeInOut',
  // Default to a "reading" scroll: step a screen, pause, scroll on — reads as a
  // person scrolling and pausing to look, and avoids a too-fast continuous glide.
  scrollStyle: 'reading',
  roundTrip: false,
  /** Reading style: dwell on each screen (ms). */
  pageHoldMs: 1000,
  /** Reading style: glide time between screens (ms). A slow, deliberate pace. */
  pageScrollMs: 2800,
  /** Reading style: fraction of a viewport advanced per page. */
  pageFraction: 1,
  /** Scroll speed in viewport-heights per second (continuous style). */
  velocityVhPerSec: 0.275,
  minDurationS: 5,
  maxDurationS: 15,
  holdStartMs: 600,
  holdEndMs: 800,
  urlMode: 'animate',
  warmup: 'images',
  waitUntil: 'networkidle',
  afterLoadMs: 400,
  settlePerFrameMs: 0,
  crf: 18,
  gifWidth: 720,
  gifFps: 15,
} as const;

const httpUrl = z
  .string()
  .url()
  .refine(
    (u) => {
      try {
        return ['http:', 'https:'].includes(new URL(u).protocol);
      } catch {
        return false;
      }
    },
    { message: 'url must use http:// or https:// (blocks file:, data:, javascript:, etc.)' },
  );

const urlInput = z.object({
  kind: z.literal('url'),
  url: httpUrl,
});

const imageInput = z.object({
  kind: z.literal('image'),
  path: z.string().min(1).optional(),
  data: z.instanceof(Uint8Array).optional(),
});

const inputSchema = z.discriminatedUnion('kind', [urlInput, imageInput]);

/**
 * A single pause point for reading-style scroll. Exactly one of selector /
 * offset / percent identifies WHERE to pause (scrolled to the top of the
 * viewport); optional holdMs overrides the global page-hold for this stop.
 */
export const ScrollStopSchema = z
  .object({
    selector: z.string().min(1).optional(),
    offset: z.number().min(0).optional(),
    percent: z.number().min(0).max(100).optional(),
    holdMs: z.number().min(0).optional(),
  })
  .refine(
    (s) => [s.selector, s.offset, s.percent].filter((v) => v !== undefined).length === 1,
    { message: 'each stop requires exactly one of: selector, offset, percent' },
  );
export type ScrollStop = z.infer<typeof ScrollStopSchema>;

export const CaptureOptionsSchema = z
  .object({
    input: inputSchema,
    format: z.enum(FORMATS).default(DEFAULTS.format),
    size: z
      .object({
        width: z.number().int().positive().default(DEFAULTS.width),
        height: z.number().int().positive().default(DEFAULTS.height),
      })
      .default({}),
    fps: z.number().int().positive().default(DEFAULTS.fps),
    /** Explicit scroll-phase duration in seconds; overrides scrollSpeed + clamps. */
    duration: z.number().positive().optional(),
    /** Scroll speed in viewport-heights per second. */
    scrollSpeed: z.number().positive().default(DEFAULTS.velocityVhPerSec),
    minDurationS: z.number().positive().default(DEFAULTS.minDurationS),
    maxDurationS: z.number().positive().default(DEFAULTS.maxDurationS),
    easing: z.enum(EASINGS).default(DEFAULTS.easing),
    scrollStyle: z.enum(SCROLL_STYLES).default(DEFAULTS.scrollStyle),
    roundTrip: z.boolean().default(DEFAULTS.roundTrip),
    /** Reading style: explicit pause points (replaces the automatic every-screen stops). */
    stops: z.array(ScrollStopSchema).optional(),
    pageHoldMs: z.number().min(0).default(DEFAULTS.pageHoldMs),
    pageScrollMs: z.number().min(0).default(DEFAULTS.pageScrollMs),
    pageFraction: z.number().positive().max(1).default(DEFAULTS.pageFraction),
    holds: z
      .object({
        startMs: z.number().min(0).default(DEFAULTS.holdStartMs),
        endMs: z.number().min(0).default(DEFAULTS.holdEndMs),
      })
      .default({}),
    waits: z
      .object({
        afterLoadMs: z.number().min(0).default(DEFAULTS.afterLoadMs),
        settlePerFrameMs: z.number().min(0).default(DEFAULTS.settlePerFrameMs),
        waitUntil: z.enum(WAIT_UNTIL).default(DEFAULTS.waitUntil),
        selectors: z.array(z.string()).optional(),
      })
      .default({}),
    urlMode: z.enum(URL_MODES).default(DEFAULTS.urlMode),
    warmup: z.enum(WARMUP_MODES).default(DEFAULTS.warmup),
    scale: z.number().positive().default(DEFAULTS.scale),
    /** Override the browser User-Agent (URL mode); defaults to realistic desktop Chrome. */
    userAgent: z.string().optional(),
    respectReducedMotion: z.boolean().default(false),
    hideFixed: z.boolean().default(false),
    /** Cap travel for infinite-scroll pages (CSS px of content height). */
    maxHeightPx: z.number().int().positive().optional(),
    quality: z
      .object({
        crf: z.number().int().min(0).max(51).default(DEFAULTS.crf),
        gifWidth: z.number().int().positive().default(DEFAULTS.gifWidth),
        gifFps: z.number().int().positive().default(DEFAULTS.gifFps),
      })
      .default({}),
    /** Server-side safety caps (enforced at validation time when present). */
    limits: z
      .object({
        maxWidth: z.number().int().positive().optional(),
        maxHeight: z.number().int().positive().optional(),
        maxDurationMs: z.number().int().positive().optional(),
        maxFps: z.number().int().positive().optional(),
        /** Cap on decoded source-image pixels (decompression-bomb guard). */
        maxSourcePixels: z.number().int().positive().optional(),
      })
      .optional(),
  })
  .superRefine((opts, ctx) => {
    if (opts.input.kind === 'image') {
      const hasPath = typeof opts.input.path === 'string';
      const hasData = opts.input.data instanceof Uint8Array;
      if (hasPath === hasData) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['input'],
          message: 'image input requires exactly one of "path" or "data"',
        });
      }
    }

    // Enforce the safety caps so the contract a host relies on is real, not advisory.
    const lim = opts.limits;
    if (lim) {
      const fail = (path: (string | number)[], message: string): void =>
        ctx.addIssue({ code: z.ZodIssueCode.custom, path, message });
      if (lim.maxWidth !== undefined && opts.size.width > lim.maxWidth)
        fail(['size', 'width'], `width ${opts.size.width} exceeds limit ${lim.maxWidth}`);
      if (lim.maxHeight !== undefined && opts.size.height > lim.maxHeight)
        fail(['size', 'height'], `height ${opts.size.height} exceeds limit ${lim.maxHeight}`);
      if (lim.maxFps !== undefined && opts.fps > lim.maxFps)
        fail(['fps'], `fps ${opts.fps} exceeds limit ${lim.maxFps}`);
      if (
        lim.maxDurationMs !== undefined &&
        opts.duration !== undefined &&
        opts.duration * 1000 > lim.maxDurationMs
      )
        fail(['duration'], `duration exceeds limit ${lim.maxDurationMs}ms`);
    }
  });

/** The validated, fully-formed capture request (all defaults applied). */
export type CaptureOptions = z.infer<typeof CaptureOptionsSchema>;
/** The raw, pre-validation shape a caller may pass (defaults still optional). */
export type CaptureOptionsInput = z.input<typeof CaptureOptionsSchema>;

export type CaptureInput = CaptureOptions['input'];

export interface CaptureProgress {
  phase: CapturePhase;
  framesDone?: number;
  framesTotal?: number;
  percent?: number;
  message?: string;
}

// ---------------------------------------------------------------------------
// Async job contracts (used later by the web API + worker; locked in now so the
// SPA and worker can be built in parallel against a stable shape).
// ---------------------------------------------------------------------------

export const JOB_STATUSES = ['queued', 'running', 'succeeded', 'failed'] as const;
export type JobState = (typeof JOB_STATUSES)[number];

export const JobStatusSchema = z.object({
  jobId: z.string().min(1),
  status: z.enum(JOB_STATUSES),
  percent: z.number().min(0).max(100).optional(),
  phase: z.enum(CAPTURE_PHASES).optional(),
  message: z.string().optional(),
  /** Blob path of the finished artifact (set when succeeded). */
  blobPath: z.string().optional(),
  /** Sanitized failure reason (set when failed). */
  error: z.string().optional(),
  createdAt: z.string().optional(),
});
export type JobStatus = z.infer<typeof JobStatusSchema>;

/** A queued unit of work: a jobId + the request to run. */
export const JobSchema = z.object({
  jobId: z.string().min(1),
  request: CaptureOptionsSchema,
});
export type Job = z.infer<typeof JobSchema>;
