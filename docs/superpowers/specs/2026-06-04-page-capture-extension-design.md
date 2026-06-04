# page-capture as a Chrome extension — design

**Status:** draft for review · **Date:** 2026-06-04 · **Author:** george + Claude

## 1. Context & decision

`page-capture` turns a web page into a smooth scrolling MP4 for slide decks, faithfully reproducing scroll-triggered *and* time-based animations. The headless/server engine (Node + Playwright + ffmpeg) hit a wall on the demanding requirements — **60fps, embedded `<video>`, WebGL/3D, behind Cloudflare** — because headless Chromium has no GPU (WebGL → SwiftShader ~1–5fps), ships without proprietary codecs (`<video>` won't play), tops out ~30fps on CDP screencast, and fights bot-detection constantly. Meeting all of that server-side would mandate a GPU cloud worker (Azure GPU VM + NVENC + framebuffer capture) — high cost and ops.

**Decision (this spec):** rebuild as a **Chrome extension (Manifest V3)** that records in the user's *real* browser. This dissolves three of the four hard problems by construction — real GPU (faithful WebGL), real codecs (`<video>` plays), real logged-in session (Cloudflare/SSO is a non-issue). The remaining axis, "60fps constant," is **re-scoped (approved) to best-effort ~60fps capture reclocked to true CFR in WebCodecs** — acceptable for deck clips.

**Confirmed scope decisions:**
- The programmatic/at-scale Azure API was aspirational → **focus purely on the extension.** No hybrid server fork to maintain.
- Distinct-frame CFR-60 is **not** required → reclocked CFR (occasional duplicated frames under load) is fine.
- **No DRM** content in scope → the EME black-capture exception is irrelevant.

## 2. Goals / non-goals

**Goals**
- Turn the page in the user's active tab into a smooth scrolling **H.264 MP4** that opens in PowerPoint / Keynote / Google Slides / QuickTime.
- Faithfully capture whatever the real browser renders: CSS/Lottie/GSAP reveals, WebGL/canvas, non-DRM `<video>`.
- Reuse the existing scroll "brain" (easing, frame plan, reading/continuous/round-trip, stops) unchanged.
- Run entirely client-side; **no upload, no server, no Azure**.
- Be installable for Hexagon colleagues via enterprise force-install.

**Non-goals**
- Headless / unattended / at-scale server capture (explicitly dropped).
- Guaranteed distinct-frame CFR under load.
- DRM/EME video, `chrome://`/Web-Store pages, capturing background (non-foreground) tabs.
- GIF output in v1 (MP4 only; GIF can come later from the same frames).

## 3. Architecture (MV3)

Three runtime contexts + a popup, around one shared "brain":

```
┌─────────────┐   click (user gesture)   ┌──────────────────────────────┐
│   Popup     │ ── options + Start ─────▶ │  Service worker (broker)     │
│ (options UI)│                           │  - tabCapture.getMediaStreamId│
└─────────────┘                           │  - create offscreen doc       │
                                          │  - inject content script      │
                                          └───────┬───────────────┬───────┘
                                       streamId+plan│              │ plan
                                                    ▼              ▼
                            ┌───────────────────────────┐   ┌──────────────────────────┐
                            │  Offscreen document        │   │  Content script (ISOLATED)│
                            │  CAPTURE + ENCODE          │   │  SCROLL DRIVER             │
                            │  getUserMedia(tab stream)  │   │  warm-up / consent /       │
                            │  → MediaStreamTrackProcessor│   │  hideFixed / measure height│
                            │  → WebCodecs VideoEncoder  │   │  → wall-clock rAF scroll   │
                            │  → CFR reclock → Mediabunny│◀──│    (samples motion plan)   │
                            │  → MP4 → downloads.download │   │  → "done" message          │
                            └───────────────────────────┘   └──────────────────────────┘
                                          ▲
                                          └────── shared brain: @page-capture/shared (zod schema, DEFAULTS)
                                                  + motion (buildFramePlan / offsetForFrame / EASINGS)
```

**Why this split:** all media work (MediaStream, WebCodecs, MediaRecorder) must live in the **offscreen document** — the MV3 service worker has no DOM and can be suspended (~30s idle) mid-job, so it stays a thin, stateless broker. The **content script** is in the page (ISOLATED world), so it does DOM prep + drives the scroll. The **popup** collects options and validates them against the shared zod schema.

### 3.1 Capture + encode pipeline (offscreen document)

1. `navigator.mediaDevices.getUserMedia({ video: { mandatory: { chromeMediaSource:'tab', chromeMediaSourceId: streamId, maxWidth:1920, maxHeight:1080, maxFrameRate: fps } } })` — **video only** (avoids tab-audio muting); `fps` is the requested output rate.
2. `new MediaStreamTrackProcessor({ track }).readable.getReader()` → a stream of `VideoFrame`s with real timestamps.
3. **Encoder selection ladder** (gate before committing, surface which path ran):
   - `await VideoEncoder.isConfigSupported({ codec:'avc1.640028', width, height, bitrate, framerate:60, hardwareAcceleration:'prefer-hardware', avc:{format:'avc'} })` → **WebCodecs `VideoEncoder` (H.264) + Mediabunny muxer** (`fastStart:'in-memory'`). **This is the deliverable.**
   - else software H.264 (OpenH264) via the same path;
   - else `MediaRecorder` with `video/mp4;codecs=avc1...` if `isTypeSupported`;
   - else `MediaRecorder` `video/webm;codecs=vp9` — **robustness floor only** (VFR/WebM), never the promised output.
4. **CFR reclock (earns the smooth-CFR claim):** maintain output index `n`; target PTS = `round(n / fps * 1_000_000)` µs on a fixed `1000/fps` ms grid (16.667ms at 60fps, 33.33ms at 30fps). For each incoming `VideoFrame`, advance `n` across slots — **duplicate** the last frame for empty slots, **drop** extras when several arrive in one slot. Keyframe every ~`5×fps` frames. `frame.close()` after every encode to avoid backpressure/GC stalls. (Honest: under-delivered slots are duplicated, not distinct — accepted.)
5. Mux → `Blob` → `chrome.downloads.download`. Long captures stream to a chunked Mediabunny target rather than buffering whole.

**Encoding params:** `avc1.640028` (High@L4.0), `bitrate ≈ 14 Mbps` (screen-content text), `bitrateMode:'quality'`/`latencyMode:'quality'`, yuv420p 4:2:0 8-bit (WebCodecs default), `fastStart` for slide-app compatibility.

### 3.2 Scroll driver (content script)

Runs in the page before/while capturing:
1. **Prep** (ported DOM logic): `document.fonts.ready`, inject `scroll-behavior:auto`, consent-dismiss click loop, lazy-image neutralize (`data-src`→`src`, `loading='eager'`, `img.decode()`) **without pre-scrolling** (preserves once-only reveals), optional `hideFixed`, normalize zoom to 100%.
2. **Measure** content height (`documentElement.scrollHeight`, capped by `maxHeightPx`), resolve `stops` (selector → `getBoundingClientRect().top + scrollY`; offset/percent arithmetic).
3. **Build plan** via `buildFramePlan({ contentHeight, viewportHeight: innerHeight, ...options })`.
4. **Drive** a wall-clock rAF loop: `t0 = performance.now()`; each tick `frame = min(totalFrames-1, round((now - t0) * fps / 1000)); window.scrollTo(0, plan.offsetForFrame(frame))`; when `frame === totalFrames-1`, message the offscreen doc to finalize. The live compositor + tabCapture produce frames at real cadence; we *sample* the plan by time instead of *stepping* it.

## 4. Code reuse — what ports, what's replaced

**Ports verbatim** (pure / browser-safe TypeScript):
- `packages/core/src/motion.ts` — the entire motion brain (`buildFramePlan`, `offsetForFrame`, `EASINGS`, segment model). Only a `import type { EasingName }`. **Unchanged.**
- `packages/shared` — zod `CaptureOptionsSchema`, `ScrollStopSchema`, `DEFAULTS`, enums, types. `zod` runs in the browser; popup + (legacy) CLI share one validated request shape.
- The **DOM bodies** of `resolveStops`, `hideFixed`, consent-dismiss, lazy-image warm-up, `measureStableHeight` — currently wrapped in Playwright `page.evaluate`; the wrappers are stripped and the bodies run directly in the content script.

**Replaced:**
- The Playwright frame loop (`scrollTo → settle → screenshot`) → the wall-clock rAF driver.
- `packages/core/src/encode/ffmpeg.ts` (Node `spawn('ffmpeg')`) → WebCodecs + Mediabunny in the offscreen doc.
- `preparePage`/navigation → there is no `goto`; it's the user's already-loaded tab.

**Dropped (irrelevant in a real browser):** `browserFactory`, `urlPolicy`/SSRF gate, realistic-UA spoof, `--disable-blink-features=AutomationControlled`, the `Job`/`JobStatus`/worker contracts, `packages/cli`, `packages/worker`.

### 4.1 Monorepo restructure

Extract the browser-safe pieces so the extension imports them cleanly:
- Keep **`packages/shared`** (already browser-safe).
- Create **`packages/scroll-engine`** (or fold into `shared`): the pure `motion.ts` + the browser-safe DOM-prep/stops helpers (no Playwright). Both the extension and any future consumer import this.
- New **`packages/extension`**: MV3 sources (`manifest.json`, `sw.ts`, `offscreen.ts`, `content.ts`, `popup/`), built with **WXT** (MV3-first framework: manifest generation, HMR, offscreen/content-script entry handling) — recommended over hand-rolled tsup+manifest. *(Build tool is a decision — see §9.)*
- `packages/core` (Playwright/ffmpeg), `packages/cli`, `packages/worker` are **deleted** once `motion.ts` and the browser-safe DOM helpers have been extracted into `packages/scroll-engine`/`shared`. Their git history (if any) is the only reference needed.

## 5. Options & UX

- **Popup** form maps to `CaptureOptions`: format (MP4), width/height (default 1920×1080), fps (default 30, opt-in 60), scroll-style (reading/continuous), round-trip, page-hold/page-scroll, stops (inline or JSON), easing, holds, max-height.
- **Pre-flight** before Start: refuse if the target tab isn't foregrounded; warn if display < 60Hz and fps=60; normalize page zoom to 100%.
- **During capture:** progress (frame N / total) relayed popup ↔ content script; a visible "recording" state; **Abort**.
- **On finish:** auto-download the MP4; show which encode path ran (HW H.264 / SW H.264 / WebM-fallback) so the user knows if they got the high-quality path.
- **Preconditions surfaced in UI:** keep the tab in front and don't switch/minimize during capture.

## 6. Robustness & error handling

- **Encoder fallback ladder** (§3.1) with explicit surfacing; never silently ship WebM when MP4 was promised.
- **Focus/visibility loss:** detect `document.visibilityState`/`blur` and `track.onended`; pause-and-warn or abort cleanly rather than emit a corrupted file. (Background tabs throttle rAF + freeze capture.)
- **MV3 lifecycle:** keep the offscreen document alive for the whole recording; the SW may die and must not hold state. Close encoder + tracks on finish/abort to avoid leaks.
- **Memory:** 1080p60 H.264 ≈ 90–112 MB/min → stream to a chunked muxer target for multi-minute captures; `fastStart:'in-memory'` is fine for short clips.
- **Crispness:** normalize zoom; size capture in CSS px to native 1080p; raise bitrate for text; verify on hexagon.com.

## 7. Distribution, security, privacy

- **Distribution:** enterprise force-install — submit an **unlisted/domain-private** Chrome Web Store item (passes review once), then Hexagon IT force-installs via `ExtensionInstallForcelist` using the CWS extension ID. Force-install also **waives the per-use gesture** and grants permissions silently. *(Requires Workspace-admin cooperation — line up early.)*
- **Permissions:** `tabCapture`, `offscreen`, `activeTab`, `scripting`, `downloads`. Prefer `activeTab` over `<all_urls>` to minimize warnings.
- **Privacy/security:** encode **100% locally, never upload**; single-purpose (scroll-capture recorder); document in the Limited Use disclosure. Sensitive because it can record logged-in internal sessions — local-only posture is the mitigation.

## 8. Testing

- **Unit (vitest, ported):** `motion.ts` frame-plan math (already covered); the **CFR reclock algorithm** (pure function over timestamped frames → assert output count, PTS grid, duplicate/drop behavior); stops resolution; zod schema defaults.
- **Component:** offscreen encode path against synthetic `VideoFrame`s → assert a valid MP4 is produced and opens.
- **Manual E2E:** load the unpacked extension in real Chrome; capture a local **fixture page** (CSS reveal + WebGL canvas + non-DRM `<video>`) and hexagon.com; verify smoothness, fidelity, text crispness, and that the MP4 plays in PowerPoint.
- *Note:* `tabCapture` is unsupported in headless, so automated capture E2E is limited — pure logic is unit-tested; capture is manually verified. (Playwright can load an extension in headed Chromium for some popup/UI automation.)

## 9. Open decisions (for the plan)

1. **Default fps:** 30 (matches production recorders) with 60 opt-in for capable machines, or 60 default? *(Lean: 30 default, 60 opt-in.)*
2. **Build tool:** WXT (recommended) vs CRXJS+Vite vs hand-rolled tsup+manifest.
3. **Legacy code:** ~~archive vs delete~~ — **RESOLVED: delete** `packages/core`/`cli`/`worker` after extracting the browser-safe pieces.
4. **Mediabunny** as the muxer (maintained successor to mp4-muxer/webm-muxer) — confirm acceptable dependency.
5. Cross-origin iframes / persistent consent banners can't be reliably scroll-driven/dismissed — define the UX when prep can't clear them (warn + proceed?).

## 10. Honest limitations (carried from research)

- **~60fps is best-effort**, reclocked to CFR (duplicated frames in compositor-starved slots). Needs a ≥60Hz monitor to reach 60 at all.
- **Foreground-only:** switching tabs / minimizing / losing focus mid-scroll gaps or kills the capture.
- **Cloudflare reduced, not eliminated:** real session defeats the dominant automation signal; TLS/behavioral/IP fingerprinting remains (low practical risk for passive viewing).
- **Cross-origin iframes** can't be scroll-driven; **consent banners** are best-effort dismiss.
- **DRM/EME video** captures black (out of scope — no DRM content).
- **HW H.264 not universal** even on real machines → fallback ladder; on Linux WebCodecs lacks AAC (irrelevant on the Windows target; video-only capture anyway).
