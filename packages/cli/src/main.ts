#!/usr/bin/env node
import { existsSync, readFileSync } from 'node:fs';
import { extname } from 'node:path';
import { Command, InvalidArgumentError } from 'commander';
import {
  Capture,
  CaptureAbortedError,
  InvalidOptionsError,
  NavigationError,
  type CaptureProgress,
  type CaptureResult,
  type Logger,
} from '@page-capture/core';
import { parseStopsString, toCaptureOptions, type CliFlags } from './options';

const int = (v: string): number => {
  const n = Number(v);
  if (!Number.isInteger(n)) throw new InvalidArgumentError('expected an integer');
  return n;
};
const num = (v: string): number => {
  const n = Number(v);
  if (!Number.isFinite(n)) throw new InvalidArgumentError('expected a number');
  return n;
};
const collect = (v: string, prev: string[]): string[] => prev.concat([v]);

function makeLogger(verbose: boolean, quiet: boolean): Logger {
  const noop = (): void => {};
  return {
    debug: verbose ? (...a) => console.error('[debug]', ...a) : noop,
    info: verbose ? (...a) => console.error('[info]', ...a) : noop,
    // Warnings (e.g. an unresolved stop selector) surface unless --quiet.
    warn: quiet ? noop : (...a) => console.error(...a),
    error: (...a) => console.error(...a),
  };
}

let lastRenderedPct = -1;
function renderProgress(p: CaptureProgress): void {
  const pct = p.percent ?? 0;
  // Only repaint when the percent changes (avoids one write per frame).
  if (pct === lastRenderedPct && p.phase !== 'finalize') return;
  lastRenderedPct = pct;
  const frames =
    p.framesDone != null && p.framesTotal != null
      ? ` (${p.framesDone}/${p.framesTotal})`
      : '';
  process.stderr.write(
    `\rpage-capture: ${p.phase.padEnd(8)} ${String(pct).padStart(3, ' ')}%${frames}   `,
  );
}

function report(result: CaptureResult, outputPath: string): void {
  const mb = (result.byteLength / (1024 * 1024)).toFixed(2);
  const secs = (result.durationMs / 1000).toFixed(1);
  process.stdout.write(
    `✓ wrote ${outputPath}  ` +
      `[${result.dimensions.width}x${result.dimensions.height} ${result.format}, ` +
      `${secs}s, ${result.frameCount} frames, ${mb} MB]\n`,
  );
}

function fail(err: unknown): never {
  const message = err instanceof Error ? err.message : String(err);
  process.stderr.write(`\npage-capture: error: ${message}\n`);
  if (err instanceof InvalidOptionsError) process.exit(2);
  if (err instanceof CaptureAbortedError) process.exit(130);
  if (err instanceof NavigationError) process.exit(3);
  process.exit(1);
}

async function run(input: string, opts: Record<string, unknown>): Promise<void> {
  const flags = opts as unknown as CliFlags;
  const quiet = opts.quiet === true;
  const verbose = opts.verbose === true;

  let built: ReturnType<typeof toCaptureOptions>;
  try {
    built = toCaptureOptions(input, flags);
  } catch (e) {
    fail(e);
  }
  const { options, outputPath, format } = built;

  // Pause points: --stops (inline) or --stops-file (JSON), but not both.
  if (opts.stops !== undefined && opts.stopsFile !== undefined) {
    fail(new InvalidOptionsError('use either --stops or --stops-file, not both'));
  }
  if (opts.stopsFile !== undefined) {
    try {
      options.stops = JSON.parse(readFileSync(String(opts.stopsFile), 'utf8'));
    } catch (e) {
      fail(new InvalidOptionsError(`could not read --stops-file: ${(e as Error).message}`));
    }
  } else if (opts.stops !== undefined) {
    try {
      options.stops = parseStopsString(String(opts.stops));
    } catch (e) {
      fail(e);
    }
  }

  if (existsSync(outputPath) && opts.overwrite !== true) {
    fail(new InvalidOptionsError(`output already exists: ${outputPath} (use --overwrite)`));
  }

  const ext = extname(outputPath).toLowerCase();
  if (!quiet) {
    const style = flags.scrollStyle ?? 'reading';
    if (options.stops && style === 'continuous') {
      process.stderr.write(
        'page-capture: warning: --stops only apply to reading style; ignored with --scroll-style continuous.\n',
      );
    }
    if (
      style === 'reading' &&
      [flags.duration, flags.velocity, flags.minDuration, flags.maxDuration].some(
        (v) => v !== undefined,
      )
    ) {
      process.stderr.write(
        'page-capture: warning: --duration/--velocity/--min-duration/--max-duration are ignored ' +
          'in reading mode; use --scroll-style continuous, or --page-hold/--page-scroll to pace reading.\n',
      );
    }
    if ((format === 'gif' && ext === '.mp4') || (format === 'mp4' && ext === '.gif')) {
      process.stderr.write(
        `page-capture: warning: format is ${format} but output ends in ${ext}\n`,
      );
    }
    if (format === 'gif') {
      process.stderr.write(
        'page-capture: warning: GIF output can be large; MP4 is smaller and smoother for long scrolls.\n',
      );
    }
  }

  const cap = new Capture(options, {
    output: { kind: 'file', path: outputPath },
    logger: makeLogger(verbose, quiet),
    ...(quiet ? {} : { onProgress: renderProgress }),
  });

  const onSigint = (): void => cap.abort();
  process.on('SIGINT', onSigint);
  try {
    const result = await cap.start();
    if (!quiet) process.stderr.write('\n');
    report(result, outputPath);
  } catch (e) {
    fail(e);
  } finally {
    process.off('SIGINT', onSigint);
  }
}

const program = new Command();
program
  .name('page-capture')
  .description('Turn a screenshot or URL into a scrolling MP4/GIF for slide decks.')
  .version('0.1.0')
  .argument('<input>', 'URL (http/https) or path to a tall screenshot (.png/.jpg/.webp)')
  .option('-o, --output <file>', 'output path (default: capture.mp4)')
  .option('-f, --format <mp4|gif>', 'output format (default: mp4, or inferred from --output)')
  .option('--overwrite', 'overwrite the output file if it exists')
  .option('--type <url|image>', 'force the input type (default: auto-detect)')
  .option('--width <px>', 'output width', int)
  .option('--height <px>', 'output height', int)
  .option('--fps <n>', 'frame rate', int)
  .option('--scale <n>', 'deviceScaleFactor for URL crispness', num)
  .option('--easing <name>', 'easeInOut|easeInOutSine|smoothstep|linear|easeIn|easeOut')
  .option(
    '--scroll-style <reading|continuous>',
    'reading (default): pause on each screen; continuous: one smooth glide',
  )
  .option('--round-trip', 'after reaching the bottom, scroll back up to the top')
  .option('--page-hold <ms>', 'reading style: dwell on each screen (default 1000)', int)
  .option('--page-scroll <ms>', 'reading style: glide time between screens (default 2800)', int)
  .option('--page-fraction <n>', 'reading style: viewports advanced per page (0-1, default 1)', num)
  .option(
    '--stops <list>',
    'reading style: pause points, e.g. "#hero@2000, 1200, 66%, footer" (selector/px/% with optional @ms)',
  )
  .option(
    '--stops-file <path>',
    'reading style: JSON file of [{ selector|offset|percent, holdMs? }] pause points',
  )
  .option('--velocity <vh-per-sec>', 'continuous style: scroll speed in viewport-heights/sec', num)
  .option('--duration <s>', 'continuous style: explicit scroll duration (overrides velocity)', num)
  .option('--min-duration <s>', 'continuous style only: lower clamp for computed duration', num)
  .option('--max-duration <s>', 'continuous style only: upper clamp for computed duration', num)
  .option('--hold-start <ms>', 'hold at the top before scrolling', int)
  .option('--hold-end <ms>', 'hold at the bottom after scrolling', int)
  .option('--mode <animate|static>', 'URL only: animate (default) or static')
  .option(
    '--warmup <images|none|full>',
    'URL only (default: images): images=load lazy media without scrolling (keeps scroll reveals); none=record cold; full=pre-scroll (consumes once-only reveals; static pages)',
  )
  .option('--user-agent <ua>', 'override the browser User-Agent (URL mode)')
  .option('--wait-until <state>', 'load|domcontentloaded|networkidle (default: networkidle)')
  .option('--wait <ms>', 'extra settle after load', int)
  .option('--settle-per-frame <ms>', 'extra wait per frame', int)
  .option('--selector <css>', 'consent/overlay selector to dismiss (repeatable)', collect, [])
  .option('--respect-reduced-motion', 'emulate prefers-reduced-motion:reduce')
  .option('--hide-fixed', 'neutralize fixed/sticky elements')
  .option('--max-height <px>', 'cap travel for infinite-scroll pages', int)
  .option('--crf <n>', 'H.264 quality (0-51, lower is better)', int)
  .option('--gif-width <px>', 'GIF downscale width', int)
  .option('--gif-fps <n>', 'GIF frame rate', int)
  .option('-q, --quiet', 'suppress progress output')
  .option('--verbose', 'verbose logging')
  .action(run);

program.parseAsync(process.argv).catch((e) => fail(e));
