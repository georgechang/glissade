import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { type Browser, chromium } from 'playwright-core';
import sharp from 'sharp';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { preparePage, warmUpPage } from '../src/page-prep';

let server: Server;
let baseUrl: string;
let browser: Browser;

async function buildFixtureHtml(): Promise<string> {
  const blue = (
    await sharp({
      create: { width: 200, height: 80, channels: 3, background: { r: 20, g: 40, b: 220 } },
    })
      .png()
      .toBuffer()
  ).toString('base64');

  // #once starts hidden and is revealed (once) the first time it intersects the
  // viewport. It sits well below the 720px fold, so it is only revealed if the
  // warm-up scrolls it into view.
  return `<!doctype html><html><head><meta charset="utf-8"><style>
    body { margin: 0; background: #fff; }
    #lazy { display: block; }
    #once { height: 120px; width: 100%; background: #fff; opacity: 0; transition: opacity 0.1s linear; }
    #once.shown { opacity: 1; background: rgb(220,20,20); }
  </style></head><body>
    <img id="lazy" data-src="data:image/png;base64,${blue}" width="200" height="80" alt="">
    <div style="height:1400px"></div>
    <div id="once"></div>
    <div style="height:600px"></div>
    <script>
      var io = new IntersectionObserver(function (entries) {
        entries.forEach(function (e) {
          if (e.isIntersecting) { e.target.classList.add('shown'); io.unobserve(e.target); }
        });
      });
      io.observe(document.getElementById('once'));
    </script>
  </body></html>`;
}

beforeAll(async () => {
  const html = await buildFixtureHtml();
  server = createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(html);
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
  browser = await chromium.launch({ headless: true, args: ['--disable-dev-shm-usage'] });
});

afterAll(async () => {
  await browser?.close();
  server?.close();
});

async function newPreparedPage() {
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  await preparePage(page, {
    url: baseUrl,
    waitUntil: 'load',
    afterLoadMs: 100,
    hideFixed: false,
  });
  return page;
}

const onceOpacity = (page: import('playwright-core').Page): Promise<string> =>
  page.evaluate(() => getComputedStyle(document.getElementById('once')!).opacity);

describe('warmUpPage', () => {
  it('"images" does NOT consume a below-the-fold scroll reveal', async () => {
    const page = await newPreparedPage();
    try {
      await warmUpPage(page, 'images');
      // No scroll happened, so #once never intersected -> still armed (hidden).
      expect(parseFloat(await onceOpacity(page))).toBe(0);
    } finally {
      await page.close();
    }
  });

  it('"images" still loads a data-src lazy image (no scroll needed)', async () => {
    const page = await newPreparedPage();
    try {
      await warmUpPage(page, 'images');
      const loaded = await page.evaluate(() => {
        const img = document.getElementById('lazy') as HTMLImageElement;
        return Boolean(img.getAttribute('src')) && img.complete && img.naturalWidth > 0;
      });
      expect(loaded).toBe(true);
    } finally {
      await page.close();
    }
  });

  it('"full" warms by scrolling and therefore consumes the reveal', async () => {
    const page = await newPreparedPage();
    try {
      await warmUpPage(page, 'full');
      expect(parseFloat(await onceOpacity(page))).toBeGreaterThan(0.5);
    } finally {
      await page.close();
    }
  });

  it('"none" leaves the reveal armed', async () => {
    const page = await newPreparedPage();
    try {
      await warmUpPage(page, 'none');
      expect(parseFloat(await onceOpacity(page))).toBe(0);
    } finally {
      await page.close();
    }
  });
});
