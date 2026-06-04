import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import { createImageFrameSource, type ImageSourceParams } from '../src/frame-source/image';

const dir = mkdtempSync(join(tmpdir(), 'pc-img-'));

/** A tall vertical-gradient PNG so different scroll offsets yield different pixels. */
async function makeTallPng(w: number, h: number): Promise<Buffer> {
  const raw = Buffer.alloc(w * h * 3);
  for (let y = 0; y < h; y++) {
    const v = Math.round((y / Math.max(1, h - 1)) * 255);
    for (let x = 0; x < w; x++) {
      const o = (y * w + x) * 3;
      raw[o] = v;
      raw[o + 1] = 255 - v;
      raw[o + 2] = 128;
    }
  }
  return sharp(raw, { raw: { width: w, height: h, channels: 3 } }).png().toBuffer();
}

const motion = {
  fps: 30,
  scrollSpeed: 1.1,
  minDurationS: 2,
  maxDurationS: 4,
  holdStartMs: 200,
  holdEndMs: 200,
  easing: 'easeInOut' as const,
};

async function collect(frames: AsyncIterable<Buffer>): Promise<Buffer[]> {
  const out: Buffer[] = [];
  for await (const f of frames) out.push(Buffer.from(f)); // copy the view to snapshot it
  return out;
}

describe('createImageFrameSource', () => {
  it('pans a tall image: rgb24 frames, correct count, distinct top vs bottom', async () => {
    const png = await makeTallPng(400, 2000);
    const params: ImageSourceParams = {
      input: { data: new Uint8Array(png) },
      outWidth: 400,
      outHeight: 300,
      ...motion,
    };
    const src = await createImageFrameSource(params);

    expect(src.inputFormat).toEqual({
      kind: 'rawvideo',
      pixfmt: 'rgb24',
      width: 400,
      height: 300,
    });
    expect(src.framePlan.distance).toBe(1700); // 2000 - 300

    const frames = await collect(src.frames);
    expect(frames.length).toBe(src.framePlan.totalFrames);
    for (const f of frames) expect(f.length).toBe(400 * 300 * 3);

    // top hold vs bottom hold differ (gradient); a mid frame differs from the top
    expect(Buffer.compare(frames[0]!, frames.at(-1)!)).not.toBe(0);
    const mid = frames[Math.floor(frames.length / 2)]!;
    expect(Buffer.compare(frames[0]!, mid)).not.toBe(0);
  });

  it('accepts a file path as input', async () => {
    const png = await makeTallPng(320, 1200);
    const p = join(dir, 'tall.png');
    writeFileSync(p, png);
    const src = await createImageFrameSource({
      input: { path: p },
      outWidth: 320,
      outHeight: 240,
      ...motion,
    });
    expect(src.framePlan.distance).toBe(960);
    const frames = await collect(src.frames);
    expect(frames.length).toBe(src.framePlan.totalFrames);
  });

  it('letterboxes a short image into a static clip (distance 0, identical frames)', async () => {
    const png = await makeTallPng(400, 100);
    const src = await createImageFrameSource({
      input: { data: new Uint8Array(png) },
      outWidth: 400,
      outHeight: 300,
      ...motion,
    });
    expect(src.framePlan.distance).toBe(0);
    const frames = await collect(src.frames);
    expect(frames.length).toBe(src.framePlan.totalFrames);
    for (const f of frames) expect(f.length).toBe(400 * 300 * 3);
    expect(Buffer.compare(frames[0]!, frames.at(-1)!)).toBe(0);
  });
});
