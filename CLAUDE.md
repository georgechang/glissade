# CLAUDE.md

## What this is

A **Chrome MV3 extension** (built with [WXT](https://wxt.dev)) that records the user's
active browser tab **scrolling down a page** into a smooth **H.264 MP4**, for slide decks.
It records the page's **entrance/on-load animations** (starts at first paint) and
**scroll-triggered animations**, all client-side — no server, no upload.

> History: this began as a headless Node + Playwright + ffmpeg engine. That approach was
> **deleted** — capturing 60fps + `<video>` + WebGL faithfully on heavy/Cloudflare sites was
> only practical in the user's real browser. Don't reintroduce Playwright/ffmpeg/`chrome-headless-shell`.
> See `memory` notes via the project memory index, and `docs/superpowers/specs|plans/2026-06-04-*`.

## Commands

```bash
npm install                                   # provisions WXT; runs `wxt prepare`
npm run build                                 # builds shared → scroll-engine → extension
npm run typecheck                             # ROOT tsc: shared + scroll-engine ONLY (see gotcha)
npm run typecheck --workspace=@page-capture/extension   # extension self-typecheck (wxt prepare && tsc)
npm test                                      # vitest (unit tests; pure logic only)
npm run dev                                   # wxt dev (live-reload extension)
npm run build --workspace=@page-capture/extension       # → packages/extension/.output/chrome-mv3/
```

Load in Chrome: `chrome://extensions` → Developer mode → **Load unpacked** →
`packages/extension/.output/chrome-mv3`. After any rebuild, click the extension's **reload ↻**.

## Layout (npm workspaces, ESM, TS `moduleResolution: Bundler`, Node ≥22)

- **`packages/shared`** — `zod` `CaptureOptionsSchema`, `DEFAULTS`, `PROFILES` (slow/medium/fast),
  `normalizePreset` (uploadable stop-config JSON), enums/types. Browser-safe; imported everywhere.
- **`packages/scroll-engine`** — pure, browser-safe, **unit-tested**: `motion.ts` (`buildFramePlan`/
  `offsetForFrame`/easings), `reclock.ts` (`frameAtElapsed`), `dom-prep.ts` (consent-dismiss,
  lazy-image neutralize, hideFixed, `measureStableHeight`, `resolveStops`). No DOM-layout deps
  (layout-sensitive bits take injectables) so it tests under happy-dom.
- **`packages/extension`** — the WXT MV3 app. `entrypoints/{background,content}.ts`,
  `entrypoints/{popup,offscreen}.html`, `src/{popup,offscreen,encoder,messages}.ts`.

## Capture architecture (the runtime flow)

Four contexts, one typed message protocol (`src/messages.ts`, gated by `isMessage`):
**popup** (options form) → **background SW** (broker) → **offscreen doc** (capture+encode) +
**content script** (DOM prep + wall-clock scroll). Flow on Record:

1. `getMediaStreamId` (fresh activeTab) → `capture:acquire` → offscreen `getUserMedia`, **holds** the track.
2. reload the tab → wait for the new page's **first paint** (`page:firstPaint` from a `document_start`
   content script: PerformanceObserver FCP + double-rAF fallback).
3. `capture:go` → offscreen starts encoding (sizes the canvas from the **first captured `VideoFrame`**).
4. bounded ~2.5s wait for `complete` (entrance animations recorded as the intro).
5. `drive:start` → content measures the scroll plan (`holdStart = pageHoldMs`, so it dwells at the top
   before scrolling) → `capture:bound` (frame cap) + `progress:total` → `scroll:start`.
6. content scrolls (eased, wall-clock) → `drive:done` → offscreen finalizes → `capture:done` →
   **background downloads** the blob.

Encoding: `MediaStreamTrackProcessor` (`maxBufferSize:1`) → draw latest frame to an `OffscreenCanvas`
→ **Mediabunny** `CanvasSource` → H.264 MP4. `MediaRecorder` (WebM/MP4) is the fallback when WebCodecs
H.264 is unavailable.

## Conventions & gotchas (hard-won — read before editing)

- **Use WXT `browser.*`, never `chrome.*`.** On Chrome, `browser` *is* `chrome` with full types
  (incl. `tabCapture`, `offscreen`). Import `{ browser } from 'wxt/browser'` in `src/`; in
  `entrypoints/*`, `browser` + `defineBackground`/`defineContentScript` are WXT auto-imports.
- **Offscreen & popup *scripts* live in `src/`** (`src/offscreen.ts`, `src/popup.ts`), referenced from
  `entrypoints/{offscreen,popup}.html`. A `.ts` directly under `entrypoints/` becomes its own
  entrypoint and collides — keep non-entry scripts in `src/`.
- **The extension is EXCLUDED from the root `tsconfig.json`** (it has browser-only types). Root
  typecheck = shared + scroll-engine. The extension self-typechecks via `wxt prepare && tsc`. Run BOTH.
- **`shared`/`scroll-engine` must be BUILT** (`dist/`) for the extension to resolve them by package name
  — `npm run build` builds them first. After editing those packages, rebuild before extension typecheck/build.
- **Download happens in the background SW** — offscreen documents have no `chrome.downloads`. Offscreen
  makes the blob URL and passes it via `capture:done`; the SW saves it.
- **Recording is gated on the new page's FIRST PAINT, not `document_start`/load.** Chrome's *Paint
  Holding* keeps the OLD page's pixels on the captured surface until the new page's FCP — gating earlier
  films the old page.
- **The encoder stamps each frame by REAL elapsed time** (`(performance.now()-t0)/1000`), not `n/fps`.
  When encoding can't sustain fps (HiDPI/4K frames), `n/fps` compresses the timeline so playback runs
  faster than the live scroll. Mediabunny normalizes real timestamps onto the fps grid.
- **Mediabunny / WebCodecs / `MediaStreamTrackProcessor` are browser-only** — none of the capture/encode
  path can run under vitest; it's verified by the manual E2E. Unit tests cover only the pure logic in
  `scroll-engine`/`shared` (run against source via the vitest aliases in `vitest.config.ts`).

## Testing

- **Unit (`npm test`):** pure logic only (motion plan, `frameAtElapsed`, DOM-prep under happy-dom via a
  `// @vitest-environment happy-dom` docblock, schema/profiles/preset). Layout-dependent helpers take
  injectables so they're testable headless.
- **Manual E2E (the real check):** `packages/extension/e2e/` — a fixture page + checklist. Must run on a
  **GPU-capable Chrome** (a no-GPU box can't exercise tabCapture/WebCodecs). Verify the first ~1s shows
  entrance animations (not the old page/blank), then a top dwell, then the scroll at the live speed.

## Working style

- The branch is `feat/chrome-extension`. Commit per logical change; don't commit to `main` without asking.
- Browser-only changes can't be unit-tested — typecheck + build, then rely on the manual E2E. Flag
  runtime-only unknowns (e.g. "does the capture stream survive the reload") rather than asserting them.
