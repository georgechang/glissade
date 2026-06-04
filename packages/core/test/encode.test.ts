import { execFile } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import ffmpegPath from 'ffmpeg-static';
import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import { encode } from '../src/encode/ffmpeg';

const execFileP = promisify(execFile);
const dir = mkdtempSync(join(tmpdir(), 'pc-encode-'));

/** Inspect a media file by parsing `ffmpeg -i` stderr (ffmpeg-static has no ffprobe). */
async function inspect(path: string): Promise<string> {
  try {
    await execFileP(ffmpegPath as string, ['-hide_banner', '-i', path]);
    return '';
  } catch (err) {
    // ffmpeg exits non-zero when no output is specified; the info is on stderr.
    return String((err as { stderr?: string }).stderr ?? '');
  }
}

async function* pngFrames(n: number, w: number, h: number): AsyncIterable<Buffer> {
  for (let i = 0; i < n; i++) {
    const c = Math.round((i / Math.max(1, n - 1)) * 255);
    yield await sharp({
      create: { width: w, height: h, channels: 3, background: { r: c, g: 100, b: 200 } },
    })
      .png()
      .toBuffer();
  }
}

async function* rawFrames(n: number, w: number, h: number): AsyncIterable<Buffer> {
  for (let i = 0; i < n; i++) {
    const buf = Buffer.alloc(w * h * 3);
    buf.fill(Math.round((i / Math.max(1, n - 1)) * 255));
    yield buf;
  }
}

describe('encode', () => {
  it('encodes PNG frames to a playable H.264 MP4 (yuv420p, correct dims)', async () => {
    const out = join(dir, 'png.mp4');
    const result = await encode({
      frames: pngFrames(30, 320, 240),
      inputFormat: { kind: 'png' },
      fps: 30,
      outWidth: 320,
      outHeight: 240,
      format: 'mp4',
      crf: 23,
      gif: { width: 240, fps: 15 },
      output: { kind: 'file', path: out },
    });
    expect(result.byteLength).toBeGreaterThan(0);
    const info = await inspect(out);
    expect(info).toMatch(/Video: h264/);
    expect(info).toMatch(/yuv420p/);
    expect(info).toMatch(/320x240/);
  });

  it('forces even output dimensions from odd input', async () => {
    const out = join(dir, 'odd.mp4');
    await encode({
      frames: pngFrames(10, 321, 241),
      inputFormat: { kind: 'png' },
      fps: 30,
      outWidth: 321,
      outHeight: 241,
      format: 'mp4',
      crf: 23,
      gif: { width: 240, fps: 15 },
      output: { kind: 'file', path: out },
    });
    const info = await inspect(out);
    // The resolution token is preceded by ", " (after the pix_fmt); anchoring on
    // it avoids matching the codec fourcc hex like "0x31637661".
    const m = info.match(/,\s(\d+)x(\d+)/);
    expect(m).toBeTruthy();
    const w = Number(m![1]);
    const h = Number(m![2]);
    expect(w % 2).toBe(0);
    expect(h % 2).toBe(0);
  });

  it('encodes rawvideo (rgb24) frames to MP4', async () => {
    const out = join(dir, 'raw.mp4');
    await encode({
      frames: rawFrames(20, 160, 120),
      inputFormat: { kind: 'rawvideo', pixfmt: 'rgb24', width: 160, height: 120 },
      fps: 20,
      outWidth: 160,
      outHeight: 120,
      format: 'mp4',
      crf: 23,
      gif: { width: 120, fps: 15 },
      output: { kind: 'file', path: out },
    });
    const info = await inspect(out);
    expect(info).toMatch(/Video: h264/);
    expect(info).toMatch(/160x120/);
  });

  it('delivers MP4 bytes to a buffer output (starts with ftyp box)', async () => {
    const result = await encode({
      frames: pngFrames(15, 160, 120),
      inputFormat: { kind: 'png' },
      fps: 15,
      outWidth: 160,
      outHeight: 120,
      format: 'mp4',
      crf: 28,
      gif: { width: 120, fps: 15 },
      output: { kind: 'buffer' },
    });
    expect(result.buffer).toBeInstanceOf(Buffer);
    expect(result.buffer!.length).toBe(result.byteLength);
    // ISO-BMFF: bytes 4..8 are the 'ftyp' box type
    expect(result.buffer!.subarray(4, 8).toString('ascii')).toBe('ftyp');
  });

  it('encodes a GIF (two-pass palette) to a file', async () => {
    const out = join(dir, 'out.gif');
    await encode({
      frames: pngFrames(20, 200, 150),
      inputFormat: { kind: 'png' },
      fps: 20,
      outWidth: 200,
      outHeight: 150,
      format: 'gif',
      crf: 23,
      gif: { width: 120, fps: 10 },
      output: { kind: 'file', path: out },
    });
    const info = await inspect(out);
    expect(info).toMatch(/Video: gif/);
    // GIF magic header
    expect(readFileSync(out).subarray(0, 3).toString('ascii')).toBe('GIF');
  });

  it('rejects (does not hang) when the frame source throws mid-stream', async () => {
    async function* boom(): AsyncIterable<Buffer> {
      yield await sharp({
        create: { width: 160, height: 120, channels: 3, background: { r: 1, g: 2, b: 3 } },
      })
        .png()
        .toBuffer();
      throw new Error('frame source exploded');
    }
    await expect(
      encode({
        frames: boom(),
        inputFormat: { kind: 'png' },
        fps: 30,
        outWidth: 160,
        outHeight: 120,
        format: 'mp4',
        crf: 28,
        gif: { width: 120, fps: 15 },
        output: { kind: 'buffer' },
      }),
    ).rejects.toThrow(/exploded/);
  }, 20_000);

  it('aborts when the signal fires', async () => {
    const ac = new AbortController();
    ac.abort();
    await expect(
      encode({
        frames: pngFrames(30, 160, 120),
        inputFormat: { kind: 'png' },
        fps: 30,
        outWidth: 160,
        outHeight: 120,
        format: 'mp4',
        crf: 23,
        gif: { width: 120, fps: 15 },
        output: { kind: 'buffer' },
        signal: ac.signal,
      }),
    ).rejects.toThrow();
  });
});
