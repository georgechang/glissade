import type { EasingName } from '@glissade/shared';

/**
 * The shared motion engine — the single source of truth for how a scroll maps
 * onto frames. It is pure (no I/O) and used identically by the image and URL
 * frame sources, so the "feel" of the scroll is defined in exactly one place.
 */

export type EasingFn = (t: number) => number;

const clamp01 = (t: number): number => (t < 0 ? 0 : t > 1 ? 1 : t);

const EASINGS: Record<EasingName, EasingFn> = {
  linear: (t) => clamp01(t),
  easeIn: (t) => {
    const p = clamp01(t);
    return p * p * p;
  },
  easeOut: (t) => {
    const p = clamp01(t);
    return 1 - Math.pow(1 - p, 3);
  },
  // cubic ease-in-out — CSS cubic-bezier(0.42, 0, 0.58, 1) equivalent
  easeInOut: (t) => {
    const p = clamp01(t);
    return p < 0.5 ? 4 * p * p * p : 1 - Math.pow(-2 * p + 2, 3) / 2;
  },
  easeInOutSine: (t) => {
    const p = clamp01(t);
    return -(Math.cos(Math.PI * p) - 1) / 2;
  },
  smoothstep: (t) => {
    const p = clamp01(t);
    return p * p * (3 - 2 * p);
  },
};

export function getEasing(name: EasingName): EasingFn {
  return EASINGS[name];
}

/**
 * Scroll style:
 *  - 'continuous': one smooth eased pass top -> bottom (velocity/duration driven)
 *  - 'reading': step one viewport at a time, dwelling on each screen, as if a
 *    person scrolls, pauses to read, then scrolls on
 */
export type ScrollStyle = 'continuous' | 'reading';

export interface FramePlanParams {
  /** Total scrollable content height in CSS px (image height or page scrollHeight). */
  contentHeight: number;
  /** Fixed recording viewport height in CSS px. */
  viewportHeight: number;
  fps: number;
  /** Scroll speed in viewport-heights per second (continuous style). */
  scrollSpeed: number;
  /** Explicit scroll-phase duration in seconds (continuous style); overrides scrollSpeed. */
  duration?: number;
  minDurationS: number;
  maxDurationS: number;
  holdStartMs: number;
  holdEndMs: number;
  easing: EasingName;
  style?: ScrollStyle;
  /** Scroll back up to the top after reaching the bottom. */
  roundTrip?: boolean;
  /** Reading style: dwell at each screen (ms). */
  pageHoldMs?: number;
  /** Reading style: glide time between screens (ms). */
  pageScrollMs?: number;
  /** Reading style: fraction of a viewport advanced per page (default 1). */
  pageFraction?: number;
  /**
   * Reading style: explicit pause points (resolved to scroll offsets in px),
   * replacing the automatic every-viewport stops. The scroll starts at the top
   * and ends at the last stop. Per-stop holdMs overrides the global page hold.
   */
  stops?: Array<{ offset: number; holdMs?: number }>;
}

export interface FramePlan {
  totalFrames: number;
  /** Total frames spent scrolling (informational). */
  scrollFrames: number;
  holdFramesTop: number;
  holdFramesBottom: number;
  scrollSeconds: number;
  /** Total scrollable distance D = max(0, contentHeight - viewportHeight). */
  distance: number;
  /** Integer scroll offset (CSS px) for a given frame index (accepts fractional positions). */
  offsetForFrame: (i: number) => number;
  /**
   * Continuous scroll offset (CSS px) at real elapsed time. The live scroll driver
   * calls this every animation frame so motion runs at the display's refresh rate
   * instead of stepping on the coarse fps grid (which `frameAtElapsed` quantizes to).
   */
  offsetAtElapsed: (elapsedMs: number) => number;
}

const clampRange = (value: number, lo: number, hi: number): number =>
  Math.min(Math.max(value, lo), hi);

interface Segment {
  kind: 'hold' | 'scroll';
  frames: number;
  from: number;
  to: number;
}

/**
 * Build a deterministic frame plan: how many frames, and the eased scroll offset
 * at each one. Identical for image panning and live URL scrolling. The motion is
 * expressed as a sequence of hold/scroll segments so reading-style dwells and
 * round trips compose naturally; 'continuous' one-way output is unchanged.
 */
export function buildFramePlan(params: FramePlanParams): FramePlan {
  const {
    contentHeight,
    viewportHeight,
    fps,
    scrollSpeed,
    duration,
    minDurationS,
    maxDurationS,
    holdStartMs,
    holdEndMs,
    easing,
  } = params;
  const style = params.style ?? 'continuous';
  const roundTrip = params.roundTrip ?? false;
  const ease = getEasing(easing);

  const distance = Math.max(0, Math.round(contentHeight - viewportHeight));
  const framesFor = (ms: number): number => Math.round((ms * fps) / 1000);
  const holdFramesTop = framesFor(holdStartMs);
  const holdFramesBottom = framesFor(holdEndMs);
  const pageHoldFrames = framesFor(params.pageHoldMs ?? 1000);

  const segments: Segment[] = [];
  const pushHold = (offset: number, frames: number): void => {
    if (frames > 0) segments.push({ kind: 'hold', frames, from: offset, to: offset });
  };
  const pushScroll = (from: number, to: number, frames: number): void => {
    if (frames <= 0) return;
    if (from === to) pushHold(from, frames);
    else segments.push({ kind: 'scroll', frames, from, to });
  };

  // Continuous-style scroll duration (also used for round-trip legs).
  const velocityPxPerSec = scrollSpeed * viewportHeight;
  const contScrollSeconds =
    duration ??
    (distance <= 0 ? 0 : clampRange(distance / velocityPxPerSec, minDurationS, maxDurationS));
  const contScrollFrames = Math.max(1, Math.round(contScrollSeconds * fps));

  if (style === 'continuous') {
    pushHold(0, holdFramesTop);
    pushScroll(0, distance, contScrollFrames);
    if (roundTrip) {
      pushHold(distance, holdFramesBottom); // turnaround dwell (controlled by --hold-end)
      pushScroll(distance, 0, contScrollFrames);
      pushHold(0, holdFramesBottom);
    } else {
      pushHold(distance, holdFramesBottom);
    }
  } else {
    // Reading style: glide to each stop and dwell. Stops are either the caller's
    // explicit pause points or auto-generated every (pageFraction * viewport) px.
    const pageScrollFrames = Math.max(1, framesFor(params.pageScrollMs ?? 700));
    const holdFramesFor = (ms: number | undefined, fallback: number): number =>
      ms !== undefined ? framesFor(ms) : fallback;

    let targets: Array<{ offset: number; holdMs?: number }>;
    if (params.stops && params.stops.length > 0) {
      const seen = new Set<number>();
      targets = params.stops
        .map((s) => ({ offset: clampRange(Math.round(s.offset), 0, distance), holdMs: s.holdMs }))
        .sort((a, b) => a.offset - b.offset)
        .filter((s) => (seen.has(s.offset) ? false : (seen.add(s.offset), true)));
    } else {
      const advance = Math.max(1, Math.round((params.pageFraction ?? 1) * viewportHeight));
      targets = [];
      for (let y = 0; y < distance; ) {
        y = Math.min(y + advance, distance);
        targets.push({ offset: y });
      }
    }

    pushHold(0, holdFramesTop);
    let prev = 0;
    for (let i = 0; i < targets.length; i++) {
      const t = targets[i]!;
      pushScroll(prev, t.offset, pageScrollFrames);
      const isFinalDown = i === targets.length - 1;
      pushHold(t.offset, holdFramesFor(t.holdMs, isFinalDown && !roundTrip ? holdFramesBottom : pageHoldFrames));
      prev = t.offset;
    }
    if (roundTrip) {
      for (let i = targets.length - 2; i >= 0; i--) {
        const t = targets[i]!;
        pushScroll(prev, t.offset, pageScrollFrames);
        pushHold(t.offset, holdFramesFor(t.holdMs, pageHoldFrames));
        prev = t.offset;
      }
      pushScroll(prev, 0, pageScrollFrames);
      pushHold(0, holdFramesBottom);
    }
  }

  // Guarantee at least one frame (e.g. content shorter than the viewport with no holds).
  if (segments.length === 0) pushHold(0, 1);

  const totalFrames = segments.reduce((n, s) => n + s.frames, 0);
  const scrollFrames = segments.reduce((n, s) => n + (s.kind === 'scroll' ? s.frames : 0), 0);

  const offsetForFrame = (i: number): number => {
    let idx = i;
    for (const seg of segments) {
      if (idx < seg.frames) {
        if (seg.kind === 'hold') return seg.from;
        // A 1-frame scroll segment must land on its target (not its origin);
        // for >= 2 frames this is identical to idx / (frames - 1).
        const p = seg.frames <= 1 ? 1 : idx / (seg.frames - 1);
        return Math.round(seg.from + ease(p) * (seg.to - seg.from));
      }
      idx -= seg.frames;
    }
    const last = segments[segments.length - 1];
    return last ? last.to : 0;
  };

  // Map real elapsed time onto a fractional frame position and evaluate the plan
  // there. offsetForFrame interpolates within segments, so this yields smooth,
  // sub-frame motion — the live driver no longer quantizes the scroll to fps steps.
  const offsetAtElapsed = (elapsedMs: number): number => {
    const lastFrame = totalFrames - 1;
    const f = (elapsedMs / 1000) * fps;
    return offsetForFrame(f < 0 ? 0 : f > lastFrame ? lastFrame : f);
  };

  return {
    totalFrames,
    scrollFrames,
    holdFramesTop,
    holdFramesBottom,
    scrollSeconds: scrollFrames / fps,
    distance,
    offsetForFrame,
    offsetAtElapsed,
  };
}
