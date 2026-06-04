/**
 * Generate reviewable sample artifacts under samples/ covering every functional
 * path: image -> MP4, image -> GIF, URL animate -> MP4, URL static -> MP4.
 *
 * Run with: npm run samples   (builds the workspace first)
 */
import { execFile } from 'node:child_process';
import { readFileSync, writeFileSync, statSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import ffmpegPath from 'ffmpeg-static';
import { chromium } from 'playwright-core';
import { capture, type CaptureOptionsInput } from '@page-capture/core';

const execFileP = promisify(execFile);
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const samplesDir = join(root, 'samples');

const WIDTH = 1280;
const HEIGHT = 720;

async function serveFixture(): Promise<{ server: Server; url: string }> {
  const html = readFileSync(join(samplesDir, 'fixture', 'index.html'));
  const server = createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(html);
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address() as AddressInfo;
  return { server, url: `http://127.0.0.1:${port}/` };
}

async function screenshotFixture(url: string, outPath: string): Promise<void> {
  const browser = await chromium.launch({
    headless: true,
    args: ['--force-color-profile=srgb', '--hide-scrollbars', '--disable-dev-shm-usage'],
  });
  try {
    const page = await browser.newPage({ viewport: { width: WIDTH, height: HEIGHT } });
    await page.goto(url, { waitUntil: 'networkidle' });
    await page.waitForTimeout(300);
    await page.screenshot({ path: outPath, fullPage: true, type: 'png' });
  } finally {
    await browser.close();
  }
}

async function probe(path: string): Promise<string> {
  try {
    await execFileP(ffmpegPath as string, ['-hide_banner', '-i', path]);
    return '';
  } catch (err) {
    const s = String((err as { stderr?: string }).stderr ?? '');
    const video = s.match(/Stream #0:0.*?: (Video:[^\n]*)/)?.[1] ?? 'unknown';
    return video.trim();
  }
}

const mb = (n: number): string => `${(n / (1024 * 1024)).toFixed(2)} MB`;

interface SampleSpec {
  file: string;
  title: string;
  command: string;
  options: CaptureOptionsInput;
}

async function main(): Promise<void> {
  const { server, url } = await serveFixture();
  const screenshot = join(samplesDir, 'source-screenshot.png');
  const rows: string[] = [];

  try {
    console.log('• capturing full-page screenshot of the fixture…');
    await screenshotFixture(url, screenshot);
    const shotH = (await import('sharp')).default(screenshot);
    const meta = await shotH.metadata();
    console.log(`  source-screenshot.png ${meta.width}x${meta.height}`);

    // Default 'reading' style: scroll a screen, pause ~1s, scroll on.
    const common = { size: { width: WIDTH, height: HEIGHT }, fps: 30 } as const;
    const specs: SampleSpec[] = [
      {
        file: 'image-scroll.mp4',
        title: 'Image → MP4 (reading style — pauses on each screen)',
        command: `page-capture samples/source-screenshot.png -o image-scroll.mp4 --width ${WIDTH} --height ${HEIGHT}`,
        options: { input: { kind: 'image', path: screenshot }, format: 'mp4', ...common },
      },
      {
        file: 'image-scroll.gif',
        title: 'Image → GIF',
        command: `page-capture samples/source-screenshot.png -o image-scroll.gif --width ${WIDTH} --height ${HEIGHT} --gif-width 640`,
        options: {
          input: { kind: 'image', path: screenshot },
          format: 'gif',
          quality: { gifWidth: 640, gifFps: 15 },
          ...common,
        },
      },
      {
        file: 'url-animated.mp4',
        title: 'URL (animate, reading) → MP4 — reveals + pause-per-screen (default)',
        command: `page-capture <url> -o url-animated.mp4 --width ${WIDTH} --height ${HEIGHT} --warmup none`,
        options: {
          input: { kind: 'url', url },
          format: 'mp4',
          warmup: 'none',
          waits: { afterLoadMs: 300, waitUntil: 'networkidle' },
          ...common,
        },
      },
      {
        file: 'url-roundtrip.mp4',
        title: 'URL (animate, reading + round trip) → scrolls down then back up',
        command: `page-capture <url> -o url-roundtrip.mp4 --round-trip --width ${WIDTH} --height ${HEIGHT} --warmup none`,
        options: {
          input: { kind: 'url', url },
          format: 'mp4',
          warmup: 'none',
          roundTrip: true,
          waits: { afterLoadMs: 300, waitUntil: 'networkidle' },
          ...common,
        },
      },
      {
        file: 'url-continuous.mp4',
        title: 'URL (animate, continuous) → MP4 — one smooth glide (for comparison)',
        command: `page-capture <url> -o url-continuous.mp4 --scroll-style continuous --duration 6 --warmup none`,
        options: {
          input: { kind: 'url', url },
          format: 'mp4',
          warmup: 'none',
          scrollStyle: 'continuous',
          duration: 6,
          waits: { afterLoadMs: 300, waitUntil: 'networkidle' },
          ...common,
        },
      },
      {
        file: 'url-static.mp4',
        title: 'URL (static) → MP4 — one screenshot, panned',
        command: `page-capture <url> -o url-static.mp4 --mode static --width ${WIDTH} --height ${HEIGHT}`,
        options: {
          input: { kind: 'url', url },
          format: 'mp4',
          urlMode: 'static',
          waits: { afterLoadMs: 300, waitUntil: 'networkidle' },
          ...common,
        },
      },
    ];

    for (const spec of specs) {
      const out = join(samplesDir, spec.file);
      process.stdout.write(`• ${spec.title} → ${spec.file} … `);
      const result = await capture(spec.options, { output: { kind: 'file', path: out } });
      const video = await probe(out);
      console.log(`done (${mb(result.byteLength)}, ${result.frameCount} frames)`);
      rows.push(
        `### ${spec.title}\n\n` +
          `- **File:** \`${spec.file}\`\n` +
          `- **Command:** \`${spec.command}\`\n` +
          `- **Output:** ${result.dimensions.width}×${result.dimensions.height}, ` +
          `${(result.durationMs / 1000).toFixed(1)}s, ${result.frameCount} frames, ${mb(result.byteLength)}\n` +
          `- **ffmpeg:** \`${video}\`\n`,
      );
    }

    const readme =
      '# Sample outputs\n\n' +
      'Generated by `npm run samples`. These cover every functional path of the engine. ' +
      'MP4s are H.264/yuv420p (play in QuickTime/PowerPoint/Keynote); the GIF demonstrates the ' +
      'optional palette path. The URL samples use the self-contained animated page in ' +
      '`samples/fixture/` so they are fully reproducible offline.\n\n' +
      `Source screenshot: \`source-screenshot.png\` (${meta.width}×${meta.height}).\n\n` +
      rows.join('\n');
    writeFileSync(join(samplesDir, 'README.md'), readme);
    console.log(`\n✓ wrote ${specs.length} samples + samples/README.md`);
  } finally {
    server.close();
  }
}

main().catch((err) => {
  console.error('sample generation failed:', err);
  process.exit(1);
});
