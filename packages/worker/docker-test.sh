#!/usr/bin/env bash
#
# CI smoke test: build the worker image and run the CLI INSIDE it against a
# generated tall image, asserting a valid H.264/yuv420p MP4 comes out. This
# validates Chromium + ffmpeg + OS deps on the real Playwright base image
# before any cloud spend. Requires a running Docker daemon.
set -euo pipefail

cd "$(dirname "$0")/../.."
IMAGE="page-capture:test"

echo "==> building image (packages/worker/Dockerfile)…"
docker build -f packages/worker/Dockerfile -t "$IMAGE" .

echo "==> running engine inside the container…"
# Generate a tall PNG, run the CLI, and validate the output entirely in-container
# (no bind mounts, so no host permission issues). ffmpeg is on PATH in the image.
docker run --rm --init --entrypoint bash "$IMAGE" -c '
  set -e
  node -e "
    const sharp = require(\"sharp\");
    const w = 600, h = 3000, raw = Buffer.alloc(w * h * 3);
    for (let y = 0; y < h; y++) { const v = Math.round((y / (h - 1)) * 255);
      for (let x = 0; x < w; x++) { const o = (y * w + x) * 3; raw[o] = v; raw[o+1] = 80; raw[o+2] = 255 - v; } }
    sharp(raw, { raw: { width: w, height: h, channels: 3 } }).png().toFile(\"/tmp/in.png\").then(() => console.log(\"input ready\"));
  "
  node packages/cli/dist/main.js /tmp/in.png -o /tmp/out.mp4 --width 480 --height 270 --duration 2 --quiet
  info=$(ffmpeg -hide_banner -i /tmp/out.mp4 2>&1 || true)
  echo "$info" | grep -q "Video: h264" || { echo "FAIL: not H.264"; exit 1; }
  echo "$info" | grep -q "yuv420p"     || { echo "FAIL: not yuv420p"; exit 1; }
  echo "CONTAINER_OK"
'

echo "==> container test passed."
