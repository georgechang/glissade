import { describe, expect, it } from 'vitest';
import { buildFramePlan, getEasing, type FramePlanParams } from '../src/motion';

const base: FramePlanParams = {
  contentHeight: 10_000,
  viewportHeight: 1080,
  fps: 30,
  scrollSpeed: 1.1,
  minDurationS: 5,
  maxDurationS: 15,
  holdStartMs: 600,
  holdEndMs: 800,
  easing: 'easeInOut',
};

describe('getEasing', () => {
  it('linear is the identity', () => {
    const e = getEasing('linear');
    expect(e(0)).toBe(0);
    expect(e(0.5)).toBeCloseTo(0.5);
    expect(e(1)).toBe(1);
  });

  it('easeInOut hits 0, 0.5, 1 at the endpoints/midpoint and eases in', () => {
    const e = getEasing('easeInOut');
    expect(e(0)).toBeCloseTo(0);
    expect(e(0.5)).toBeCloseTo(0.5);
    expect(e(1)).toBeCloseTo(1);
    // ease-in: early progress is slower than linear
    expect(e(0.25)).toBeLessThan(0.25);
    // ease-out: late progress is faster than linear
    expect(e(0.75)).toBeGreaterThan(0.75);
  });

  it('smoothstep hits endpoints and midpoint', () => {
    const e = getEasing('smoothstep');
    expect(e(0)).toBeCloseTo(0);
    expect(e(0.5)).toBeCloseTo(0.5);
    expect(e(1)).toBeCloseTo(1);
  });
});

describe('buildFramePlan', () => {
  it('computes hold frames from ms and fps', () => {
    const plan = buildFramePlan(base);
    expect(plan.holdFramesTop).toBe(18); // round(600 * 30 / 1000)
    expect(plan.holdFramesBottom).toBe(24); // round(800 * 30 / 1000)
  });

  it('clamps scroll duration between min and max', () => {
    // huge page -> clamp to max
    const tall = buildFramePlan({ ...base, contentHeight: 10_000_000 });
    expect(tall.scrollSeconds).toBeCloseTo(15);
    // short (but > viewport) page -> clamp to min
    const short = buildFramePlan({ ...base, contentHeight: 1200 });
    expect(short.scrollSeconds).toBeCloseTo(5);
  });

  it('honors an explicit duration override (bypasses clamp)', () => {
    const plan = buildFramePlan({ ...base, duration: 20 });
    expect(plan.scrollSeconds).toBe(20);
    expect(plan.scrollFrames).toBe(600); // 20 * 30
  });

  it('totalFrames = holdTop + scrollFrames + holdBottom', () => {
    const plan = buildFramePlan(base);
    expect(plan.totalFrames).toBe(
      plan.holdFramesTop + plan.scrollFrames + plan.holdFramesBottom,
    );
  });

  it('starts at 0 and ends at the full scroll distance D', () => {
    const plan = buildFramePlan(base);
    const D = base.contentHeight - base.viewportHeight;
    expect(plan.offsetForFrame(0)).toBe(0);
    expect(plan.offsetForFrame(plan.totalFrames - 1)).toBe(D);
  });

  it('holds the top for holdFramesTop frames and the bottom at D', () => {
    const plan = buildFramePlan(base);
    const D = base.contentHeight - base.viewportHeight;
    expect(plan.offsetForFrame(plan.holdFramesTop - 1)).toBe(0);
    expect(plan.offsetForFrame(plan.holdFramesTop + plan.scrollFrames)).toBe(D);
  });

  it('produces monotonically non-decreasing integer offsets', () => {
    const plan = buildFramePlan(base);
    let prev = -1;
    for (let i = 0; i < plan.totalFrames; i++) {
      const o = plan.offsetForFrame(i);
      expect(Number.isInteger(o)).toBe(true);
      expect(o).toBeGreaterThanOrEqual(prev);
      prev = o;
    }
  });

  it('handles content shorter than the viewport (D = 0): static held clip', () => {
    const plan = buildFramePlan({ ...base, contentHeight: 500 });
    expect(plan.totalFrames).toBeGreaterThan(0);
    for (let i = 0; i < plan.totalFrames; i++) {
      expect(plan.offsetForFrame(i)).toBe(0);
    }
  });

  it('eases: the scroll midpoint frame is near D/2', () => {
    const plan = buildFramePlan(base);
    const D = base.contentHeight - base.viewportHeight;
    const midScrollFrame = plan.holdFramesTop + Math.floor(plan.scrollFrames / 2);
    expect(plan.offsetForFrame(midScrollFrame)).toBeGreaterThan(D * 0.4);
    expect(plan.offsetForFrame(midScrollFrame)).toBeLessThan(D * 0.6);
  });
});

const reading: FramePlanParams = {
  contentHeight: 2400,
  viewportHeight: 600,
  fps: 30,
  scrollSpeed: 1.1,
  minDurationS: 5,
  maxDurationS: 15,
  holdStartMs: 300, // 9 frames
  holdEndMs: 300, // 9 frames
  easing: 'linear',
  style: 'reading',
  pageHoldMs: 900, // 27 frames
  pageScrollMs: 600, // 18 frames
  pageFraction: 1,
};

const offsets = (plan: { totalFrames: number; offsetForFrame: (i: number) => number }): number[] =>
  Array.from({ length: plan.totalFrames }, (_, i) => plan.offsetForFrame(i));

describe('buildFramePlan — reading style', () => {
  it('steps one viewport per page with a dwell at each screen', () => {
    const plan = buildFramePlan(reading);
    // stops at 0,600,1200,1800 (D=1800). segs: hold9 + (scroll18+hold27)*2 + scroll18 + holdEnd9
    expect(plan.distance).toBe(1800);
    expect(plan.totalFrames).toBe(9 + (18 + 27) + (18 + 27) + (18 + 9));

    expect(plan.offsetForFrame(0)).toBe(0);
    expect(plan.offsetForFrame(plan.totalFrames - 1)).toBe(1800);

    // The dwell at the first screen-stop (offset 600) holds for pageHold frames.
    expect(plan.offsetForFrame(27)).toBe(600); // first frame after scroll 0->600
    expect(plan.offsetForFrame(53)).toBe(600); // still dwelling
  });

  it('is monotonically non-decreasing and visits each viewport stop', () => {
    const all = offsets(buildFramePlan(reading));
    let prev = -1;
    for (const o of all) {
      expect(o).toBeGreaterThanOrEqual(prev);
      prev = o;
    }
    for (const stop of [0, 600, 1200, 1800]) {
      expect(all).toContain(stop);
    }
  });
});

describe('buildFramePlan — custom stops (reading)', () => {
  it('visits exactly the given stops, with per-stop holds, ending at the last stop', () => {
    const plan = buildFramePlan({
      ...reading, // viewport 600, distance 1800, fps 30, pageScrollMs 600(18f), pageHoldMs 900(27f), holdEnd 300(9f), holdStart 300(9f), linear
      stops: [
        { offset: 300, holdMs: 600 }, // 18f hold
        { offset: 900 }, // default pageHold 27f
        { offset: 1500, holdMs: 0 }, // no hold; also the last stop
      ],
    });
    // segs: hold(0,9) + s18 + hold(300,18) + s18 + hold(900,27) + s18 + hold(1500,0)
    expect(plan.totalFrames).toBe(9 + 18 + 18 + 18 + 27 + 18);
    expect(plan.offsetForFrame(0)).toBe(0);
    expect(plan.offsetForFrame(plan.totalFrames - 1)).toBe(1500); // ends at last stop, NOT D

    const all = offsets(plan);
    for (const stop of [300, 900, 1500]) expect(all).toContain(stop);
    expect(all).not.toContain(1800); // never scrolled to the bottom
  });

  it('normalizes stops: clamps to [0,D], sorts, and dedupes', () => {
    const plan = buildFramePlan({
      ...reading,
      stops: [{ offset: 1500 }, { offset: 9999 }, { offset: 300 }, { offset: 300 }],
    });
    const all = offsets(plan);
    // sorted/clamped/deduped -> visits 300, 1500, 1800 (9999 clamped to D=1800); 300 once
    expect(all).toContain(300);
    expect(all).toContain(1500);
    expect(all).toContain(1800);
    let prev = -1;
    for (const o of all) {
      expect(o).toBeGreaterThanOrEqual(prev);
      prev = o;
    }
  });

  it('round trips through custom stops back to the top', () => {
    const plan = buildFramePlan({
      ...reading,
      roundTrip: true,
      stops: [{ offset: 600 }, { offset: 1200 }],
    });
    expect(plan.offsetForFrame(0)).toBe(0);
    expect(plan.offsetForFrame(plan.totalFrames - 1)).toBe(0);
    expect(Math.max(...offsets(plan))).toBe(1200);
  });
});

describe('buildFramePlan — round trip', () => {
  it('continuous round trip ends back at the top and reaches D in the middle', () => {
    const plan = buildFramePlan({
      ...base,
      contentHeight: 2400,
      viewportHeight: 600,
      duration: 1,
      holdStartMs: 0,
      holdEndMs: 0,
      pageHoldMs: 0,
      easing: 'linear',
      roundTrip: true,
    });
    const all = offsets(plan);
    expect(all[0]).toBe(0);
    expect(all.at(-1)).toBe(0);
    expect(Math.max(...all)).toBe(1800);
  });

  it('reaches the bottom even when the page glide rounds to a single frame', () => {
    // pageScrollMs 20 @ 30fps -> round(0.6) = 1 frame per glide.
    const plan = buildFramePlan({
      ...reading,
      pageScrollMs: 20,
      pageHoldMs: 0,
      holdStartMs: 0,
      holdEndMs: 0,
    });
    expect(plan.offsetForFrame(plan.totalFrames - 1)).toBe(plan.distance);
  });

  it('single-frame-glide round trip still returns to the top', () => {
    const plan = buildFramePlan({
      ...reading,
      pageScrollMs: 20,
      pageHoldMs: 0,
      holdStartMs: 0,
      holdEndMs: 0,
      roundTrip: true,
    });
    expect(plan.offsetForFrame(plan.totalFrames - 1)).toBe(0);
    expect(Math.max(...offsets(plan))).toBe(plan.distance);
  });

  it('reading round trip returns to the top and is longer than one-way', () => {
    const oneWay = buildFramePlan(reading);
    const trip = buildFramePlan({ ...reading, roundTrip: true });
    expect(trip.offsetForFrame(0)).toBe(0);
    expect(trip.offsetForFrame(trip.totalFrames - 1)).toBe(0);
    const all = offsets(trip);
    expect(Math.max(...all)).toBe(1800);
    expect(trip.totalFrames).toBeGreaterThan(oneWay.totalFrames);
  });
});
