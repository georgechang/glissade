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
4. Choose **reading** style, **30** fps → click **Record this tab**. Keep the tab focused for the whole scroll.
5. A `page-capture.mp4` downloads when it finishes (the popup shows `Done (webcodecs-avc).`).

## Verify the MP4
- Opens and plays in **PowerPoint / Keynote / Google Slides / QuickTime**.
- The scroll is **smooth** top→bottom; duration ≈ the on-screen scroll time.
- **CSS reveals animate** (sections ①/⑤/⑥ fade+slide in as they enter — not pre-revealed).
- The **2D canvas** (②) and **WebGL** (③) animations move.
- The **`<video>`** (④) shows the moving "LIVE VIDEO" stream (not frozen/black).
- **Text is crisp** at 1080p.

## Also check
6. Repeat at **60** fps (needs a ≥60 Hz display) — should still be smooth.
7. Repeat on a real site (e.g. **hexagon.com**), foreground — confirm Cloudflare is a non-issue and reveals look natural.
8. Switch tabs mid-capture once — the capture should **abort cleanly** (popup shows a failure), not hang or produce a frozen file.
9. Note the reported encoder in the popup: `webcodecs-avc` expected on a capable machine; `mediarecorder-*` means the WebCodecs H.264 path was unavailable (fallback).

## Known limitations (expected, not bugs)
- ~60 fps is best-effort (auto-throttles under load; reclocked to CFR by duplicating frames).
- Must keep the captured tab foreground/focused for the whole scroll.
- DRM/EME video (Netflix-style) captures black — out of scope.
- Cross-origin iframes can't be scroll-driven; consent banners are best-effort dismissed.
