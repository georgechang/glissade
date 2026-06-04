# Worker / engine container image.
#
# Pinned to match playwright + playwright-core == 1.59.1 in the workspace
# (this image ships the matching Chromium build, chromium-1217). If you bump
# Playwright, bump this tag in lockstep or Chromium launch will fail.
FROM mcr.microsoft.com/playwright:v1.59.1-noble

# ffmpeg for encoding — the Playwright image only ships its internal recording
# shim, not a general-purpose ffmpeg. (GPL build; see LICENSING in the README.)
RUN apt-get update \
    && apt-get install -y --no-install-recommends ffmpeg \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Browsers are already baked into the base image — never re-download them.
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1

# Install dependencies first for layer caching (manifests only).
COPY package.json package-lock.json* ./
COPY packages/shared/package.json packages/shared/
COPY packages/core/package.json packages/core/
COPY packages/cli/package.json packages/cli/
RUN npm install

# Build the workspace.
COPY . .
RUN npm run build

# Run as the non-root user shipped by the Playwright image. Use `docker run --init`
# (or an init system) so Chromium/ffmpeg child processes are reaped on shutdown.
USER pwuser

# Phase 0: the CLI is the entrypoint, so the same image proves the engine runs
# (Chromium + ffmpeg + OS deps) in a container. Phase 1 swaps this for the
# queue-consumer worker, which imports @page-capture/core unchanged.
ENTRYPOINT ["node", "packages/cli/dist/main.js"]
