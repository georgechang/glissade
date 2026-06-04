import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import sharp from 'sharp';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createUrlFrameSource, type UrlSourceParams } from '../src/frame-source/url';

let server: Server;
let baseUrl: string;

async function buildFixtureHtml(): Promise<string> {
  // A blue PNG used as a lazy image (data-src only — needs warmup to appear).
  const blue = (
    await sharp({
      create: { width: 200, height: 80, channels: 3, background: { r: 20, g: 40, b: 220 } },
    })
      .png()
      .toBuffer()
  ).toString('base64');

  return `<!doctype html><html><head><meta charset="utf-8"><style>
    body { margin: 0; background: #fff; }
    .spacer { width: 100%; }
    #reveal { height: 100px; width: 100%; background: #fff; }
    #reveal.in { background: rgb(220,20,20); }
  </style></head><body>
    <div class="spacer" style="height:50px"></div>
    <img id="lazyimg" data-src="data:image/png;base64,${blue}" width="200" height="80" alt="">
    <div class="spacer" style="height:1800px"></div>
    <div id="reveal"></div>
    <div class="spacer" style="height:400px"></div>
    <script>
      var io = new IntersectionObserver(function (entries) {
        entries.forEach(function (e) {
          if (e.isIntersecting) e.target.classList.add('in');
          else e.target.classList.remove('in');
        });
      });
      io.observe(document.getElementById('reveal'));
    </script>
  </body></html>`;
}

beforeAll(async () => {
  const html = await buildFixtureHtml();
  server = createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(html);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${port}/`;
});

afterAll(() => {
  server?.close();
});

const motion = {
  fps: 20,
  scrollSpeed: 1.1,
  minDurationS: 2,
  maxDurationS: 3,
  holdStartMs: 100,
  holdEndMs: 100,
  easing: 'easeInOut' as const,
};

const baseParams = (): Omit<UrlSourceParams, 'url'> => ({
  outWidth: 600,
  outHeight: 600,
  scale: 1,
  mode: 'animate',
  warmup: 'none',
  waitUntil: 'load',
  afterLoadMs: 100,
  settlePerFrameMs: 0,
  respectReducedMotion: false,
  hideFixed: false,
  ...motion,
});

async function collect(frames: AsyncIterable<Buffer>): Promise<Buffer[]> {
  const out: Buffer[] = [];
  for await (const f of frames) out.push(f);
  return out;
}

async function pixel(png: Buffer, x: number, y: number): Promise<[number, number, number]> {
  const { data, info } = await sharp(png).raw().toBuffer({ resolveWithObject: true });
  const i = (y * info.width + x) * info.channels;
  return [data[i]!, data[i + 1]!, data[i + 2]!];
}

const isPng = (b: Buffer): boolean =>
  b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));

describe('createUrlFrameSource (animate)', () => {
  it('captures a scroll-triggered reveal (red block appears at the bottom)', async () => {
    const src = await createUrlFrameSource({ url: baseUrl, ...baseParams() });
    expect(src.inputFormat).toEqual({ kind: 'png' });
    expect(src.framePlan.distance).toBeGreaterThan(0);

    const frames = await collect(src.frames);
    await src.dispose?.();

    expect(frames.length).toBe(src.framePlan.totalFrames);
    for (const f of frames) expect(isPng(f)).toBe(true);

    // Bottom frame: the reveal block has scrolled into view -> IntersectionObserver
    // fired -> background is red. Top frame at the same screen row is white.
    const [br, bg, bb] = await pixel(frames.at(-1)!, 300, 150);
    expect(br).toBeGreaterThan(170);
    expect(bg).toBeLessThan(90);
    expect(bb).toBeLessThan(90);

    const [tr, tg, tb] = await pixel(frames[0]!, 300, 150);
    expect(tr > 200 && tg > 200 && tb > 200).toBe(true); // white spacer
  });

  it('warmup "images" loads a data-src lazy image', async () => {
    const src = await createUrlFrameSource({
      url: baseUrl,
      ...baseParams(),
      warmup: 'images',
    });
    const frames = await collect(src.frames);
    await src.dispose?.();
    // Top frame: lazy image (content y 50..130, x 0..200) is now blue.
    const [r, g, b] = await pixel(frames[0]!, 100, 90);
    expect(b).toBeGreaterThan(150);
    expect(r).toBeLessThan(120);
    expect(g).toBeLessThan(150);
  });

  it('resolves CSS-selector stops and ends at the last stop (not the bottom)', async () => {
    // #lazyimg sits near the top (~y50); with it as the only stop, the scroll
    // should end there, NOT travel to the bottom of the (tall) page.
    const src = await createUrlFrameSource({
      url: baseUrl,
      ...baseParams(),
      style: 'reading',
      stops: [{ selector: '#lazyimg' }],
    });
    const frames = await collect(src.frames);
    await src.dispose?.();
    expect(src.framePlan.distance).toBeGreaterThan(1000); // page is tall
    expect(src.framePlan.offsetForFrame(src.framePlan.totalFrames - 1)).toBeLessThan(250);
    expect(frames.length).toBe(src.framePlan.totalFrames);
  });

  it('ignores an unresolved selector (warns) without failing', async () => {
    const warnings: string[] = [];
    const src = await createUrlFrameSource({
      url: baseUrl,
      ...baseParams(),
      style: 'reading',
      stops: [{ selector: '#does-not-exist' }, { offset: 300 }],
      logger: { warn: (...a) => warnings.push(a.join(' ')) },
    });
    await collect(src.frames);
    await src.dispose?.();
    expect(warnings.some((w) => w.includes('#does-not-exist'))).toBe(true);
    // The valid offset stop still drives the end position.
    expect(src.framePlan.offsetForFrame(src.framePlan.totalFrames - 1)).toBe(300);
  });

  it('rejects when urlPolicy denies the URL (before navigation)', async () => {
    await expect(
      (async () => {
        const src = await createUrlFrameSource({
          url: baseUrl,
          ...baseParams(),
          urlPolicy: (u) => {
            throw new Error(`blocked host ${u.hostname}`);
          },
        });
        await collect(src.frames);
      })(),
    ).rejects.toThrow(/blocked host/);
  });

  it('aborts promptly when the signal fires', async () => {
    const ac = new AbortController();
    ac.abort();
    await expect(
      (async () => {
        const src = await createUrlFrameSource({
          url: baseUrl,
          ...baseParams(),
          signal: ac.signal,
        });
        await collect(src.frames);
      })(),
    ).rejects.toThrow();
  });
});

describe('createUrlFrameSource (static)', () => {
  it('produces a panned clip from one full-page screenshot', async () => {
    const src = await createUrlFrameSource({
      url: baseUrl,
      ...baseParams(),
      mode: 'static',
    });
    const frames = await collect(src.frames);
    await src.dispose?.();
    expect(frames.length).toBe(src.framePlan.totalFrames);
    expect(src.framePlan.distance).toBeGreaterThan(0);
  });
});
