import { describe, expect, it } from 'vitest';
import { CaptureOptionsSchema } from '@page-capture/shared';
import { parseStopsString, toCaptureOptions } from '../src/options';

describe('toCaptureOptions', () => {
  it('maps a URL with an explicit format and derives the default output path', () => {
    const { options, outputPath, format } = toCaptureOptions('https://example.com', {
      format: 'gif',
    });
    expect(options.input).toEqual({ kind: 'url', url: 'https://example.com' });
    expect(format).toBe('gif');
    expect(outputPath).toBe('capture.gif');
    expect(CaptureOptionsSchema.safeParse(options).success).toBe(true);
  });

  it('infers the format from the output file extension', () => {
    const { format, outputPath } = toCaptureOptions('https://example.com', {
      output: 'out/clip.gif',
    });
    expect(format).toBe('gif');
    expect(outputPath).toBe('out/clip.gif');
  });

  it('lets an explicit --format win over the output extension', () => {
    const { format } = toCaptureOptions('https://example.com', {
      output: 'clip.gif',
      format: 'mp4',
    });
    expect(format).toBe('mp4');
  });

  it('defaults to mp4 and capture.mp4', () => {
    const { format, outputPath } = toCaptureOptions('https://example.com', {});
    expect(format).toBe('mp4');
    expect(outputPath).toBe('capture.mp4');
  });

  it('maps geometry, motion, and url flags onto schema-valid options', () => {
    const { options } = toCaptureOptions('https://example.com', {
      width: 1280,
      height: 720,
      fps: 60,
      scale: 1,
      duration: 8,
      easing: 'linear',
      holdStart: 0,
      holdEnd: 500,
      mode: 'static',
      warmup: 'full',
      wait: 1000,
      waitUntil: 'domcontentloaded',
      hideFixed: true,
      maxHeight: 5000,
      crf: 20,
    });
    const parsed = CaptureOptionsSchema.parse(options);
    expect(parsed.size).toEqual({ width: 1280, height: 720 });
    expect(parsed.fps).toBe(60);
    expect(parsed.duration).toBe(8);
    expect(parsed.easing).toBe('linear');
    expect(parsed.holds).toEqual({ startMs: 0, endMs: 500 });
    expect(parsed.urlMode).toBe('static');
    expect(parsed.warmup).toBe('full');
    expect(parsed.waits.waitUntil).toBe('domcontentloaded');
    expect(parsed.hideFixed).toBe(true);
    expect(parsed.maxHeightPx).toBe(5000);
    expect(parsed.quality.crf).toBe(20);
  });

  it('forwards --type to input detection', () => {
    const { options } = toCaptureOptions('example.com', { type: 'url' });
    expect(options.input).toEqual({ kind: 'url', url: 'example.com' });
  });
});

describe('parseStopsString', () => {
  it('parses selectors, offsets (px), and percentages', () => {
    expect(parseStopsString('#hero, .features, footer')).toEqual([
      { selector: '#hero' },
      { selector: '.features' },
      { selector: 'footer' },
    ]);
    expect(parseStopsString('0, 1200px, 66%')).toEqual([
      { offset: 0 },
      { offset: 1200 },
      { percent: 66 },
    ]);
  });

  it('parses per-stop @holdMs', () => {
    expect(parseStopsString('#hero@2000, 1800@500, footer')).toEqual([
      { selector: '#hero', holdMs: 2000 },
      { offset: 1800, holdMs: 500 },
      { selector: 'footer' },
    ]);
  });

  it('trims whitespace and ignores empty tokens', () => {
    expect(parseStopsString('  #a ,, 50%  ,')).toEqual([
      { selector: '#a' },
      { percent: 50 },
    ]);
  });

  it('produces schema-valid stops', () => {
    const stops = parseStopsString('#hero@1500, 800, 90%');
    const r = CaptureOptionsSchema.safeParse({
      input: { kind: 'url', url: 'https://x.com' },
      stops,
    });
    expect(r.success).toBe(true);
  });

  it('throws on an invalid hold duration', () => {
    expect(() => parseStopsString('#hero@abc')).toThrow();
  });
});
