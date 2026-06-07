import { describe, expect, it } from 'vitest';
import {
  CaptureOptionsSchema,
  DEFAULTS,
  PROFILES,
  defaultEasingForStyle,
  normalizePreset,
  type CaptureOptions,
} from '@glissade/shared';

describe('CaptureOptionsSchema', () => {
  it('applies defaults for a minimal URL request', () => {
    const parsed = CaptureOptionsSchema.parse({
      input: { kind: 'url', url: 'https://example.com' },
    });
    expect(parsed.format).toBe('mp4');
    expect(parsed.size.width).toBe(DEFAULTS.width);
    expect(parsed.size.height).toBe(DEFAULTS.height);
    expect(parsed.fps).toBe(DEFAULTS.fps);
    expect(parsed.easing).toBe('easeInOut');
    expect(parsed.urlMode).toBe('animate');
    expect(parsed.warmup).toBe('images');
    expect(parsed.scrollStyle).toBe('reading');
    expect(parsed.roundTrip).toBe(false);
    expect(parsed.pageHoldMs).toBe(DEFAULTS.pageHoldMs);
  });

  it('accepts an image path request and an overridden format', () => {
    const parsed = CaptureOptionsSchema.parse({
      input: { kind: 'image', path: '/tmp/tall.png' },
      format: 'gif',
    });
    expect(parsed.input).toEqual({ kind: 'image', path: '/tmp/tall.png' });
    expect(parsed.format).toBe('gif');
  });

  it('accepts an image data (Uint8Array) request for programmatic callers', () => {
    const parsed = CaptureOptionsSchema.parse({
      input: { kind: 'image', data: new Uint8Array([1, 2, 3]) },
    });
    if (parsed.input.kind !== 'image') throw new Error('expected image');
    expect(parsed.input.data).toBeInstanceOf(Uint8Array);
  });

  it('rejects an invalid URL', () => {
    const r = CaptureOptionsSchema.safeParse({
      input: { kind: 'url', url: 'not a url' },
    });
    expect(r.success).toBe(false);
  });

  it('rejects dangerous URL schemes (SSRF / local file / script)', () => {
    for (const url of [
      'file:///etc/passwd',
      'data:text/html,<h1>x</h1>',
      'javascript:alert(1)',
      'ftp://host/file',
    ]) {
      expect(
        CaptureOptionsSchema.safeParse({ input: { kind: 'url', url } }).success,
      ).toBe(false);
    }
  });

  it('accepts http and https URLs', () => {
    expect(
      CaptureOptionsSchema.safeParse({ input: { kind: 'url', url: 'http://x.com' } }).success,
    ).toBe(true);
    expect(
      CaptureOptionsSchema.safeParse({ input: { kind: 'url', url: 'https://x.com' } }).success,
    ).toBe(true);
  });

  it('rejects an image input with neither path nor data', () => {
    const r = CaptureOptionsSchema.safeParse({ input: { kind: 'image' } });
    expect(r.success).toBe(false);
  });

  it('rejects an image input with BOTH path and data', () => {
    const r = CaptureOptionsSchema.safeParse({
      input: { kind: 'image', path: '/a.png', data: new Uint8Array([1]) },
    });
    expect(r.success).toBe(false);
  });

  it('rejects an unknown format', () => {
    const r = CaptureOptionsSchema.safeParse({
      input: { kind: 'url', url: 'https://x.com' },
      format: 'avi',
    });
    expect(r.success).toBe(false);
  });

  it('rejects non-positive fps and width', () => {
    expect(
      CaptureOptionsSchema.safeParse({
        input: { kind: 'url', url: 'https://x.com' },
        fps: 0,
      }).success,
    ).toBe(false);
    expect(
      CaptureOptionsSchema.safeParse({
        input: { kind: 'url', url: 'https://x.com' },
        size: { width: -10 },
      }).success,
    ).toBe(false);
  });

  it('enforces limits when provided (rejects over-cap requests)', () => {
    const base = { input: { kind: 'url', url: 'https://x.com' } } as const;
    expect(
      CaptureOptionsSchema.safeParse({ ...base, size: { width: 5000 }, limits: { maxWidth: 1920 } })
        .success,
    ).toBe(false);
    expect(
      CaptureOptionsSchema.safeParse({ ...base, fps: 120, limits: { maxFps: 60 } }).success,
    ).toBe(false);
    expect(
      CaptureOptionsSchema.safeParse({ ...base, duration: 60, limits: { maxDurationMs: 30_000 } })
        .success,
    ).toBe(false);
    // within the caps -> ok
    expect(
      CaptureOptionsSchema.safeParse({
        ...base,
        size: { width: 1280, height: 720 },
        fps: 30,
        limits: { maxWidth: 1920, maxHeight: 1080, maxFps: 60, maxDurationMs: 30_000 },
      }).success,
    ).toBe(true);
  });

  it('produces a type assignable to CaptureOptions', () => {
    const parsed = CaptureOptionsSchema.parse({
      input: { kind: 'url', url: 'https://example.com' },
    });
    const typed: CaptureOptions = parsed;
    expect(typed.format).toBe('mp4');
  });
});

describe('CaptureOptionsSchema — stops', () => {
  const withStops = (stops: unknown) =>
    CaptureOptionsSchema.safeParse({ input: { kind: 'url', url: 'https://x.com' }, stops });

  it('accepts selector, offset, and percent stops with optional holdMs', () => {
    const r = withStops([
      { selector: '#hero', holdMs: 2000 },
      { offset: 1800 },
      { percent: 80, holdMs: 500 },
    ]);
    expect(r.success).toBe(true);
  });

  it('rejects a stop with none of selector/offset/percent', () => {
    expect(withStops([{ holdMs: 100 }]).success).toBe(false);
  });

  it('rejects a stop with more than one of selector/offset/percent', () => {
    expect(withStops([{ selector: '#x', offset: 10 }]).success).toBe(false);
  });

  it('rejects an out-of-range percent', () => {
    expect(withStops([{ percent: 140 }]).success).toBe(false);
  });
});

describe('PROFILES', () => {
  it('defines slow/medium/fast and medium matches the defaults', () => {
    expect(Object.keys(PROFILES)).toEqual(['slow', 'medium', 'fast']);
    expect(PROFILES.medium.pageHoldMs).toBe(DEFAULTS.pageHoldMs);
    expect(PROFILES.medium.velocityVhPerSec).toBe(DEFAULTS.velocityVhPerSec);
    expect(PROFILES.slow.pageScrollMs).toBeGreaterThan(PROFILES.fast.pageScrollMs);
  });
});

describe('defaultEasingForStyle', () => {
  it('defaults continuous to a smooth, steady linear glide (no mid-scroll rush)', () => {
    expect(defaultEasingForStyle('continuous')).toBe('linear');
  });
  it('defaults reading to ease-in-out per screen-step (== the global default)', () => {
    expect(defaultEasingForStyle('reading')).toBe('easeInOut');
    expect(defaultEasingForStyle('reading')).toBe(DEFAULTS.easing);
  });
});

describe('normalizePreset', () => {
  it('accepts the legacy bare stop-array format', () => {
    const out = normalizePreset([{ selector: '#hero', holdMs: 2000 }, { percent: 50 }]);
    expect(out.stops).toEqual([{ selector: '#hero', holdMs: 2000 }, { percent: 50 }]);
  });
  it('accepts an extended object with profile + stops', () => {
    const out = normalizePreset({ name: 'hex', url: 'https://hexagon.com', profile: 'slow', stops: [{ offset: 100 }] });
    expect(out).toEqual({ name: 'hex', url: 'https://hexagon.com', profile: 'slow', stops: [{ offset: 100 }] });
  });
  it('rejects an invalid stop (two locators)', () => {
    expect(() => normalizePreset([{ selector: '#x', offset: 10 }])).toThrow();
  });
});
