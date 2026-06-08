# Glissade

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE) ![Chrome MV3](https://img.shields.io/badge/Chrome-MV3-4285F4?logo=googlechrome&logoColor=white) ![Node ≥22](https://img.shields.io/badge/Node-%E2%89%A522-339933?logo=nodedotjs&logoColor=white) [![PRs welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg)](#contributing)

Record the active browser tab **scrolling down a page** into a smooth **H.264 MP4** — captured
right in your real browser, with no server and no upload. Free and **open source**.

Glissade is a Chrome (Manifest V3) extension. Open any page, hit record, and it reloads the tab,
starts filming at the new page's first paint (so the entrance/on-load animations are in the clip),
then scrolls the page on a smooth, eased clock. Because it's recording your actual
GPU-composited tab, **scroll-triggered animations** (IntersectionObserver, AOS, GSAP ScrollTrigger,
lazy reveals), `<video>`, and WebGL are all captured faithfully.

Useful for demos, product walkthroughs, docs, presentations, marketing/social clips, design
reviews, or archiving how a page looks and moves.

## Why an extension

Recording your real tab gets you the things a headless/server renderer struggles with — true
~60fps, the proprietary codecs that make `<video>` play, real WebGL on a real GPU, and your
logged-in / behind-Cloudflare sessions — for free. Everything runs **100% client-side**: capture,
H.264 encoding, and download all happen on your machine. Nothing is uploaded; there's no server and
no telemetry.

## Install (load unpacked)

```bash
git clone https://github.com/georgechang/glissade.git
cd glissade
npm install
npm run build
```

Then in Chrome: `chrome://extensions` → enable **Developer mode** → **Load unpacked** → select
`packages/extension/.output/chrome-mv3`. After each rebuild, click the extension's **reload ↻**.

Building from source is the way to run it today; a Chrome Web Store listing is published from this
repo (see [Publishing](#publishing)).

## Using it

Click the toolbar icon to open the popup:

- **Speed** — *Slow / Medium / Fast* presets set the pacing (dwell + scroll speed). Pick **Custom**
  to hand-tune everything in **Advanced**.
- **Style** — **Reading** scrolls one screen, pauses to "read", then continues, the way a person
  reads down a page. **Continuous** is one smooth glide from top to bottom.
- **Round trip** — after reaching the bottom, scroll back up to the top before finishing.
- **Reload page first** *(on by default)* — reloads the tab so on-load/entrance animations replay
  and scroll reveals re-arm; recording begins at the new page's first paint so the intro is
  captured. (Unsaved changes on the tab are lost.)
- **Pause points** *(reading style)* — optionally upload a `.json` file to dwell at specific spots
  (see below).
- **Advanced** — FPS (30/60), easing curve, per-screen page-hold/page-scroll times (reading), scroll
  velocity (continuous), a max scroll height for very tall/infinite pages, an end hold, and a toggle
  to hide fixed/sticky elements while scrolling.

Press **Record this tab** and keep that tab in the foreground for the whole scroll. The button
becomes **Cancel** while recording, a red **REC** badge shows on the icon, and the MP4 downloads
when it's done (with a completion notification if the popup is closed).

Defaults worth knowing: reading style eases each screen-step (ease-in-out); **continuous defaults to
a steady linear glide** so it doesn't rush through the middle. Your last uploaded pause-points file
is remembered per page URL.

## Pause points (optional)

In reading style you can upload a `.json` array of pause points — each is scrolled to the top of the
viewport and held:

```json
[
  { "selector": "#hero", "holdMs": 2000 },
  { "percent": 40 },
  { "offset": 1200 }
]
```

Each point gives exactly one of a CSS `selector`, a `percent` (0–100) of the page, or a pixel
`offset`; the optional `holdMs` overrides the default dwell. An extended form
`{ "name": "…", "profile": "slow", "stops": [ … ] }` is also accepted and may carry a speed profile.

## How it works

Four contexts coordinate over one typed message protocol:

> **popup** (options) → **background service worker** (broker) → **offscreen document**
> (capture + encode) + **content script** (DOM prep + wall-clock scroll)

1. The popup sends your options. The background grabs the tab-capture stream while the click's
   permission is still fresh, and the offscreen document holds onto the track.
2. The tab reloads, and recording starts at the new page's **first paint** — signalled by a
   `document_start` content script. Gating any earlier would film the *old* page, because Chrome's
   *Paint Holding* keeps the old pixels on screen until the new page paints.
3. The offscreen document encodes: `chrome.tabCapture` → `MediaStreamTrackProcessor` → draw each
   frame to an `OffscreenCanvas` → [**Mediabunny**](https://mediabunny.dev) `CanvasSource` →
   H.264 MP4. It films a brief intro (entrance animations), holds at the top, then the content
   script scrolls the page on an eased, wall-clock timeline.
4. When the scroll finishes, the offscreen document hands a blob URL to the background, which saves
   the file as `glissade-<host>-<date>.mp4`.

Each frame is stamped by its **real elapsed time**, so the output duration matches the live scroll
even when encoding can't sustain the target fps (Mediabunny normalizes the timestamps onto the fps
grid). If WebCodecs H.264 isn't available, it falls back to `MediaRecorder` (MP4/avc1, or WebM/VP9).

## Develop

An npm-workspaces monorepo (ESM, TypeScript, Node ≥ 22):

- **`packages/shared`** — the zod `CaptureOptions` schema, `DEFAULTS`, the speed `PROFILES`, and
  preset normalization. Browser-safe; imported everywhere.
- **`packages/scroll-engine`** — the pure, unit-tested motion engine: frame plan + easings
  (`motion.ts`), constant-frame-rate reclock (`reclock.ts`), and DOM prep — consent dismissal,
  lazy-image neutralizing, stop resolution (`dom-prep.ts`).
- **`packages/extension`** — the WXT MV3 app (background / content / popup / offscreen).

```bash
npm run dev        # WXT live-reload dev build
npm run build      # build shared → scroll-engine → extension
npm run zip        # build + package the extension .zip
npm test           # vitest unit tests (pure logic)
npm run typecheck                                    # root: shared + scroll-engine
npm run typecheck --workspace=@glissade/extension    # extension self-typecheck
```

## Testing

- **Unit (`npm test`)** — the pure logic only: motion plan, CFR reclock, DOM helpers (under
  happy-dom), and the schema / profiles / presets.
- **Manual E2E** — `packages/extension/e2e/` (a fixture page + checklist). The capture path uses
  `tabCapture` + WebCodecs, which can't run headless, so it's verified by hand on a **GPU-capable
  Chrome**.

## Contributing

Contributions are welcome — issues and pull requests alike. Glissade is an npm-workspaces monorepo;
see [Develop](#develop) for the layout and commands.

1. Fork, clone, and `npm install`.
2. Make your change. Keep the pure logic in `scroll-engine` / `shared` covered by unit tests.
3. Before opening a PR, make sure these are green:

   ```bash
   npm run typecheck
   npm run typecheck --workspace=@glissade/extension
   npm test
   npm run build
   ```

   The capture path (tabCapture/WebCodecs) can't be unit-tested, so also sanity-check it by hand on a
   GPU-capable Chrome — see `packages/extension/e2e/`.
4. Open a PR against `main` with a clear description. Found a bug or have an idea?
   [Open an issue](https://github.com/georgechang/glissade/issues).

## Publishing

A GitHub Actions workflow builds, verifies, and uploads a **draft** to the Chrome Web Store on a
`v*` tag (you submit/publish from the dashboard). See
[`docs/publishing-chrome-web-store.md`](docs/publishing-chrome-web-store.md).

## Limitations

- Keep the captured tab in the foreground for the whole scroll — switching away aborts the capture
  cleanly.
- ~60fps is best-effort; it auto-throttles under load and is reclocked to a constant frame rate.
- DRM/EME video (e.g. Netflix) captures as black — out of scope.
- Cross-origin iframes can't be scroll-driven; consent/cookie banners are dismissed best-effort.

## Acknowledgements

Built with [WXT](https://wxt.dev) (extension framework) and [Mediabunny](https://mediabunny.dev)
(in-browser H.264 / MP4 encoding).

## License

[MIT](LICENSE) © 2026 George Chang
