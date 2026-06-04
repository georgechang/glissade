import { describe, expect, it } from 'vitest';
import { frameAtElapsed, buildSampleSchedule } from '../src/reclock';

describe('frameAtElapsed', () => {
  it('maps elapsed wall-clock to the nearest frame index at the given fps', () => {
    expect(frameAtElapsed(0, 30, 100)).toBe(0);
    expect(frameAtElapsed(1000, 30, 100)).toBe(30); // 1s @30fps = frame 30
    expect(frameAtElapsed(16, 60, 100)).toBe(1);    // ~one 60fps frame
  });
  it('clamps to [0, totalFrames-1]', () => {
    expect(frameAtElapsed(-50, 30, 100)).toBe(0);
    expect(frameAtElapsed(999_999, 30, 100)).toBe(99);
  });
});

describe('buildSampleSchedule (VFR→CFR)', () => {
  it('holds the latest captured frame across empty slots (duplicate to fill)', () => {
    // frames arrive at 0ms and 100ms; 30fps slots every ~33.33ms; 5 slots → frame0,0,0,1,1
    expect(buildSampleSchedule([0, 100], 5, 30)).toEqual([0, 0, 0, 1, 1]);
  });
  it('drops extra frames that arrive within one slot (only latest ≤ slot time wins)', () => {
    expect(buildSampleSchedule([0, 5, 10, 40], 2, 30)).toEqual([0, 2]);
  });
  it('uses frame 0 for slots before the first frame arrives', () => {
    expect(buildSampleSchedule([50], 3, 30)).toEqual([0, 0, 0]);
  });
});
