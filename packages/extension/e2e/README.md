# Manual E2E — page-capture extension

Automated tests cover the pure logic (motion plan, CFR reclock, DOM helpers). The
capture path uses `tabCapture` + WebCodecs, which don't run headless — so capture
is verified by hand here. Run this on a **GPU-capable Chrome** (not a no-GPU/WSL box),
ideally on a ≥60 Hz display.

## Setup
1. Build + load the extension:
   - `npm run build --workspace=@page-capture/extension`
   - Chrome → `chrome://extensions` → enable **Developer mode** → **Load unpacked** →
     select `packages/extension/.output/chrome-mv3`.
2. Serve the fixture (any static server), e.g. from the repo root:
   - `npx serve packages/extension/e2e` (or `python3 -m http.server -d packages/extension/e2e`)
   - Open `http://localhost:3000/fixture.html` (port as printed). **Keep this tab in the foreground.**

## Run
3. Click the **Page Capture** toolbar button → the popup opens.
4. Pick a **Profile** (Slow/Medium/Fast — auto-fills the Advanced timings), **Format** = MP4, **reading** style → click **Record this tab**. Keep the tab focused for the whole scroll.
5. By default the page **reloads first** (so scroll animations re-arm) — let it finish loading; recording starts automatically after. A `page-capture.mp4` downloads when done (the popup shows `Done (webcodecs-avc).`).

## Verify the MP4
- Opens and plays in **PowerPoint / Keynote / Google Slides / QuickTime**.
- The scroll is **smooth** top→bottom; duration ≈ the on-screen scroll time.
- **CSS reveals animate** (sections ①/⑤/⑥ fade+slide in as they enter — not pre-revealed).
- The **2D canvas** (②) and **WebGL** (③) animations move.
- The **`<video>`** (④) shows the moving "LIVE VIDEO" stream (not frozen/black).
- **Text is crisp** at 1080p.

## Also check
6. Repeat at **60** fps (Advanced → FPS; needs a ≥60 Hz display) — should still be smooth.
7. **GIF**: set Format = GIF, record again → downloads `page-capture.gif` (popup shows `Done (gif).`), downscaled (default 640px) at the GIF fps. Confirm it animates and is a reasonable size.
8. **Profiles**: switch Profile → confirm the Advanced timing fields (page-hold/scroll/velocity/holds) update; editing any flips it to "Custom".
9. **Preset upload**: pick a `.json` stop-config (e.g. the legacy `stop-configs/hexagoncom-home.json` — a bare `[{selector|offset|percent, holdMs?}]` array, or the extended `{name?,url?,profile?,stops}`). The popup shows "Loaded: N stops"; record on the matching site and confirm it pauses at those stops.
10. **Reload toggle**: Advanced → uncheck "reload page first" → recording starts immediately on the current page state (no reload).
11. Repeat on a real site (e.g. **hexagon.com**), foreground — confirm the reload completes, Cloudflare is a non-issue, and reveals look natural.
12. Switch tabs mid-capture once — the capture should **abort cleanly** (popup shows a failure), not hang or produce a frozen file.
13. Note the reported encoder in the popup: `webcodecs-avc` (MP4, capable machine) / `gif` / `mediarecorder-*` (WebCodecs H.264 unavailable → fallback).

## What the reload-first flow does
On Record, the extension grabs the tab-capture stream immediately (while the click's permission is fresh), then (unless disabled) reloads the tab and waits for it to finish loading before it starts encoding + scrolling — so the page re-initialises (scroll reveals re-arm) and the reload flash isn't in the video. **Runtime bet to confirm:** the capture stream must survive the reload; if it doesn't on your Chrome, the capture aborts with "capture track already ended" — tell me and I'll switch to acquiring after the reload.

## Known limitations (expected, not bugs)
- ~60 fps is best-effort (auto-throttles under load; reclocked to CFR by duplicating frames).
- Must keep the captured tab foreground/focused for the whole scroll.
- DRM/EME video (Netflix-style) captures black — out of scope.
- Cross-origin iframes can't be scroll-driven; consent banners are best-effort dismissed.
