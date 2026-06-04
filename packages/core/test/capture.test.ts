import { createServer, type Server } from 'node:http';
import { mkdtempSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Capture, capture, type CaptureProgress } from '../src/index';

const dir = mkdtempSync(join(tmpdir(), 'pc-capture-'));
let server: Server;
let baseUrl: string;

async function makeTallPng(w: number, h: number): Promise<Buffer> {
  const raw = Buffer.alloc(w * h * 3);
  for (let y = 0; y < h; y++) {
    const v = Math.round((y / Math.max(1, h - 1)) * 255);
    for (let x = 0; x < w; x++) {
      const o = (y * w + x) * 3;
      raw[o] = v;
      raw[o + 1] = 120;
      raw[o + 2] = 255 - v;
    }
  }
  return sharp(raw, { raw: { width: w, height: h, channels: 3 } }).png().toBuffer();
}

beforeAll(async () => {
  server = createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(
      '<!doctype html><body style="margin:0"><div style="height:2000px;background:linear-gradient(#fff,#000)"></div></body>',
    );
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
});

afterAll(() => server?.close());

const hasFtyp = (b: Buffer): boolean => b.subarray(4, 8).toString('ascii') === 'ftyp';
const isGif = (b: Buffer): boolean => b.subarray(0, 3).toString('ascii') === 'GIF';

describe('capture()', () => {
  it('renders an image into an MP4 buffer with correct metadata', async () => {
    const png = await makeTallPng(320, 1600);
    const path = join(dir, 'tall.png');
    writeFileSync(path, png);

    const result = await capture(
      {
        input: { kind: 'image', path },
        format: 'mp4',
        size: { width: 320, height: 240 },
        fps: 20,
        duration: 1,
        holds: { startMs: 0, endMs: 0 },
        scrollStyle: 'continuous',
      },
      { output: { kind: 'buffer' } },
    );

    expect(result.format).toBe('mp4');
    expect(result.contentType).toBe('video/mp4');
    expect(result.dimensions).toEqual({ width: 320, height: 240 });
    expect(result.frameCount).toBe(20); // 1s * 20fps, no holds
    expect(result.durationMs).toBe(1000);
    expect(result.buffer).toBeInstanceOf(Buffer);
    expect(hasFtyp(result.buffer!)).toBe(true);
  });

  it('forces odd requested dimensions to even', async () => {
    const png = await makeTallPng(300, 1200);
    const result = await capture(
      {
        input: { kind: 'image', data: new Uint8Array(png) },
        size: { width: 201, height: 151 },
        fps: 10,
        duration: 0.5,
        holds: { startMs: 0, endMs: 0 },
      },
      { output: { kind: 'buffer' } },
    );
    expect(result.dimensions).toEqual({ width: 200, height: 150 });
  });

  it('renders an image into a GIF', async () => {
    const png = await makeTallPng(240, 900);
    const result = await capture(
      {
        input: { kind: 'image', data: new Uint8Array(png) },
        format: 'gif',
        size: { width: 240, height: 180 },
        fps: 12,
        duration: 0.5,
        holds: { startMs: 0, endMs: 0 },
        quality: { gifWidth: 160, gifFps: 10 },
      },
      { output: { kind: 'buffer' } },
    );
    expect(result.format).toBe('gif');
    expect(isGif(result.buffer!)).toBe(true);
  });

  it('writes directly to a file output', async () => {
    const png = await makeTallPng(200, 800);
    const out = join(dir, 'file-out.mp4');
    const result = await capture(
      {
        input: { kind: 'image', data: new Uint8Array(png) },
        size: { width: 200, height: 200 },
        fps: 10,
        duration: 0.5,
        holds: { startMs: 0, endMs: 0 },
      },
      { output: { kind: 'file', path: out } },
    );
    expect(result.byteLength).toBeGreaterThan(0);
    expect(hasFtyp(require('node:fs').readFileSync(out))).toBe(true);
  });

  it('emits progress that reaches a finalize phase at 100%', async () => {
    const png = await makeTallPng(200, 1000);
    const events: CaptureProgress[] = [];
    await capture(
      {
        input: { kind: 'image', data: new Uint8Array(png) },
        size: { width: 200, height: 200 },
        fps: 15,
        duration: 0.6,
        holds: { startMs: 0, endMs: 0 },
      },
      { output: { kind: 'buffer' }, onProgress: (p) => events.push(p) },
    );
    expect(events.some((e) => e.phase === 'capture')).toBe(true);
    const last = events.at(-1)!;
    expect(last.phase).toBe('finalize');
    expect(last.percent).toBe(100);
  });

  it('captures a URL into an MP4', async () => {
    const result = await capture(
      {
        input: { kind: 'url', url: baseUrl },
        size: { width: 400, height: 400 },
        scale: 1,
        fps: 15,
        duration: 1,
        holds: { startMs: 0, endMs: 0 },
        waits: { afterLoadMs: 50, waitUntil: 'load' },
        warmup: 'none',
        scrollStyle: 'continuous',
      },
      { output: { kind: 'buffer' } },
    );
    expect(result.format).toBe('mp4');
    expect(hasFtyp(result.buffer!)).toBe(true);
  });

  it('reading style and round-trip flow through capture()', async () => {
    const png = await makeTallPng(300, 3000);
    const make = (extra: Record<string, unknown>) =>
      capture(
        {
          input: { kind: 'image', data: new Uint8Array(png) },
          size: { width: 300, height: 300 },
          fps: 15,
          holds: { startMs: 0, endMs: 0 },
          pageHoldMs: 400,
          pageScrollMs: 300,
          ...extra,
        },
        { output: { kind: 'buffer' } },
      );
    const read = await make({ scrollStyle: 'reading' });
    const trip = await make({ scrollStyle: 'reading', roundTrip: true });
    expect(read.frameCount).toBeGreaterThan(0);
    expect(trip.frameCount).toBeGreaterThan(read.frameCount); // up-leg adds frames
  });

  it('rejects invalid options', async () => {
    await expect(
      capture({ input: { kind: 'url', url: 'not a url' } }),
    ).rejects.toThrow();
  });
});

describe('Capture (lifecycle)', () => {
  it('aborts when abort() is called before start completes', async () => {
    const png = await makeTallPng(400, 4000);
    const cap = new Capture(
      {
        input: { kind: 'image', data: new Uint8Array(png) },
        size: { width: 400, height: 400 },
        fps: 30,
        duration: 10,
      },
      { output: { kind: 'buffer' } },
    );
    const p = cap.start();
    cap.abort();
    await expect(p).rejects.toThrow();
  });
});
