# page-capture

Turn a **screenshot** or a **URL** into a smooth **scrolling animation** (MP4 or GIF) for slide decks and other assets. For URLs it drives a real browser, so **scroll-triggered animations** (IntersectionObserver, AOS, GSAP ScrollTrigger, lazy reveals) are captured faithfully.

```
page-capture ./tall-screenshot.png -o scroll.mp4
page-capture https://example.com -o site.mp4 --width 1920 --height 1080
page-capture https://example.com -o site.gif --format gif
```

## Why

A slide that shows a product page "scrolling" is far more compelling than a static screenshot. `page-capture` produces that clip deterministically: smooth ease-in-out motion, brief holds at the top and bottom, exact duration, and broadly-compatible H.264 (plays in QuickTime, PowerPoint, Keynote, Google Slides).

## How it works

- **Reading-style scroll by default.** It scrolls one screen, pauses ~1s to "read", then scrolls on — the way a person actually reads down a page. Switch to one smooth glide with `--scroll-style continuous`, or have it scroll back up afterward with `--round-trip`.
- **Deterministic per-frame stepping.** Rather than recording a live screencast (which drops frames and stutters), the engine computes an eased scroll offset for each frame, scrolls there, lets the page settle, and screenshots. Scroll-triggered animations fire on scroll *position*, so stepping reproduces them faithfully — while keeping the output smooth and exactly the requested length. (Time-based animations triggered on reveal advance in real time between frames, so on very fast scrolls they can appear brief; slow the scroll — `--page-hold`/`--page-scroll`/`--velocity` — to give them room.)
- **One shared motion engine, two frame sources.** Image mode decodes the screenshot once and pans a zero-copy window down it. URL mode drives Chromium. Both feed the same encoder.
- **Bundled ffmpeg.** Encoding uses `ffmpeg-static` (H.264/`yuv420p` MP4 by default; optional two-pass-palette GIF). No system ffmpeg or Chrome required.

## Requirements

- Node.js ≥ 20 (developed on Node 24).
- No system **ffmpeg** needed (bundled via `ffmpeg-static`).
- A Chromium browser for URL mode. `npm install` provisions it via Playwright; if missing, run `npx playwright install chromium`. (Image mode needs no browser.)

## Install & build

```bash
npm install
npm run build
# then:
node packages/cli/dist/main.js --help
```

## Usage

```
page-capture <input> [options]
```

`<input>` is an `http(s)://` URL or a path to a tall screenshot (`.png/.jpg/.jpeg/.webp/...`).

Common options (run `--help` for the full list):

| Option | Default | Notes |
|---|---|---|
| `-o, --output <file>` | `capture.mp4` | format inferred from extension if `--format` omitted |
| `-f, --format <mp4\|gif>` | `mp4` | GIF is larger; a warning is printed |
| `--width` / `--height` | `1920` / `1080` | output dimensions (forced even) |
| `--fps <n>` | `30` | use `60` for fast scrolls |
| `--scroll-style <reading\|continuous>` | `reading` | `reading` pauses on each screen; `continuous` is one glide |
| `--round-trip` | off | after the bottom, scroll back up to the top |
| `--page-hold <ms>` | `1000` | *reading*: dwell on each screen |
| `--page-scroll <ms>` | `2800` | *reading*: glide time between screens |
| `--stops <list>` | — | *reading*: explicit pause points, e.g. `"#hero@2000, 1200, 66%, footer"` |
| `--stops-file <path>` | — | *reading*: JSON `[{ selector\|offset\|percent, holdMs? }]` (not combinable with `--stops`) |
| `--duration <s>` | auto | *continuous*: total scroll time (overrides `--velocity`) |
| `--velocity <vh/s>` | `0.275` | *continuous*: scroll speed in viewport-heights per second |
| `--easing <name>` | `easeInOut` | `linear`, `easeInOutSine`, `smoothstep`, … |
| `--hold-start` / `--hold-end <ms>` | `600` / `800` | holds at the very top / very end |
| `--mode <animate\|static>` | `animate` | URL only; `static` = one screenshot, panned |
| `--warmup <images\|none\|full>` | `images` | URL only; `images` loads lazy media without scrolling (keeps scroll reveals); `none` records cold; `full` pre-scrolls (consumes once-only reveals) |
| `--scale <n>` | `1` | deviceScaleFactor; `>1` supersamples for crisper text |
| `--hide-fixed` | off | neutralize sticky/fixed elements |
| `--max-height <px>` | — | cap travel for infinite-scroll pages |

### Examples

```bash
# Image → 1080p MP4 (default: reading style — pauses on each screen)
page-capture ./landing-fullpage.png -o landing.mp4

# URL, reading style, scroll down then back up, capturing reveals cold
page-capture https://example.com -o site.mp4 --round-trip --warmup none

# Linger longer on each screen (1.5s) and glide a bit slower between them
page-capture https://example.com -o site.mp4 --page-hold 1500 --page-scroll 900

# One smooth continuous glide instead of pausing per screen
page-capture https://example.com -o site.mp4 --scroll-style continuous --duration 8

# Pause at specific points (reading style). Each token is a CSS selector,
# a pixel offset, or a percent; optional @ms sets a per-stop dwell.
page-capture https://example.com -o site.mp4 --stops "#hero@2500, .pricing, 66%, footer"
# …or author them in a file (not combinable with --stops):
page-capture https://example.com -o site.mp4 --stops-file stops.json

# Image → GIF (downscaled), supersampled for crisp text
page-capture ./tall.png -o tall.gif --format gif --gif-width 720 --scale 2
```

### Pause points (reading style)

By default reading mode pauses every screen. To control exactly where it pauses, give it `--stops` (inline) or `--stops-file` (JSON) — **not both**. Each stop is one of:

- a **CSS selector** (`#hero`, `.pricing`, `footer`) — resolved in the live page; the element's top is scrolled to the top of the viewport (most robust);
- a **pixel offset** (`1200` or `1200px`) — an exact `scrollY`;
- a **percent** (`66%`) — of the scrollable distance.

Inline, append `@<ms>` to set a per-stop dwell; otherwise `--page-hold` is used. The points replace the automatic every-screen stops, are sorted/clamped/de-duplicated, and the scroll **starts at the top and ends at your last stop** (include `footer`/`100%` to reach the bottom). `--round-trip` plays them in reverse on the way back up. Unresolved selectors are warned about and skipped. (Selectors need a live DOM, so they apply to URL mode; image/`--mode static` accept offset/percent.)

```json
// stops.json
[
  { "selector": "#hero",   "holdMs": 2500 },
  { "percent": 40 },
  { "offset": 3200,        "holdMs": 800 },
  { "selector": "footer" }
]
```

## Programmatic API

The engine is a framework-agnostic library (`@page-capture/core`):

```ts
import { capture } from '@page-capture/core';
import { createWriteStream } from 'node:fs';

await capture(
  { input: { kind: 'url', url: 'https://example.com' }, format: 'mp4' },
  {
    output: { kind: 'writable', stream: createWriteStream('out.mp4') },
    onProgress: (p) => console.log(p.phase, p.percent),
    // signal, logger, browserFactory, ffmpegPath, urlPolicy all injectable
  },
);
```

**Safety knobs (relevant before any hosted/untrusted use):** URL inputs are restricted to `http(s)` at the schema level (blocks `file:`/`data:`/`javascript:`). For the future web layer, pass `runtime.urlPolicy(url => { /* throw to deny private/metadata hosts */ })` (consulted before navigation) and set `limits` (`maxWidth`/`maxHeight`/`maxFps`/`maxDurationMs`/`maxSourcePixels`) on the request — these are *enforced* at validation time, not advisory.

`output` can be `{kind:'buffer'}` (default), `{kind:'file', path}`, `{kind:'writable', stream}`, or `{kind:'stream'}`. The engine never calls `process.exit` or writes to stdout — it throws typed errors and streams output to wherever you point it, which is exactly what lets the same call back a CLI today and a web service tomorrow (see [docs/azure-architecture.md](docs/azure-architecture.md)).

## Samples

```bash
npm run samples   # writes samples/*.mp4, samples/image-scroll.gif, samples/README.md
```

Covers all four paths (image→MP4, image→GIF, URL animate→MP4, URL static→MP4) using the self-contained animated page in `samples/fixture/`, so they reproduce offline. See [samples/README.md](samples/README.md).

## Testing

```bash
npm test          # vitest: unit + integration (browser-driven URL tests included)
npm run typecheck
npm run test:docker   # builds the worker image and runs the CLI inside it (needs Docker)
```

Every functional module has tests: the motion/frame-plan math, input detection, the image and URL frame sources, the ffmpeg encoder, and the end-to-end `capture()` orchestrator. The URL test asserts a scroll-triggered reveal actually fires during capture.

## ⚠️ Licensing

`ffmpeg-static` (and `apt` ffmpeg in the container) are **GPL-3.0** builds with `libx264`. Invoking the standalone ffmpeg binary as a separate process is *mere aggregation* — it does **not** place this project's source under the GPL — but if you redistribute, you must ship the GPLv3 text and offer the corresponding ffmpeg source. **H.264/H.265 also carry patent-licensing obligations** for a redistributed or hosted product; get sign-off before deploying the hosted service. `gifski` (a higher-quality GIF encoder) is **AGPL-3.0** and is intentionally not a dependency. A non-GPL encoder fallback (VP9/AV1 WebM) is possible if needed.

## Project layout

```
packages/core/    the engine (capture(), motion, frame sources, encoder) — playwright-core + ffmpeg-static only
packages/shared/  zod schema + Job/JobStatus contracts (shared with the future web layer)
packages/cli/     thin CLI wrapper (commander)
packages/worker/  Dockerfile + container test (Phase 0); queue-consumer worker is Phase 1
scripts/          sample generation
samples/          fixture page + generated artifacts
docs/             Azure / web architecture (Phase 2)
```
