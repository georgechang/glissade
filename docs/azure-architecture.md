# Web app on Azure — architecture (Phase 2)

This documents how `page-capture` becomes a web app. **None of this is built yet** — Phase 0 (the engine + CLI) is deliberately shaped so this is a pure add-on. It is grounded in research validated against current (2025–2026) Azure docs.

## TL;DR

Feasible — but the backend is a **container**, not a vanilla Azure Function. Headless Chromium does not run on the modern serverless Functions plan (Flex Consumption is code-only / no custom container; Linux Consumption is retiring). Run the engine as an **Azure Container Apps event-driven Job** built from the official Playwright image + ffmpeg, behind a tiny always-warm HTTP API, using an **async job pattern** (renders take seconds–minutes; synchronous HTTP hits the ~230s Functions gateway timeout).

## Diagram

```
  Browser SPA ──POST /jobs──▶ HTTP API (always-warm Container App, min 1 replica)
     ▲  │                        • validate (shared zod schema)
     │  │ 202 {jobId,statusUrl}  • write status="queued"
     │  └───────────────────────  • enqueue {jobId}
     │  ◀──poll GET /jobs/{id}──         │
     │     {status,percent,phase}       ▼
     │                          Azure Storage Queue ──KEDA──▶ Container Apps JOB (worker)
     │                                                          FROM mcr.microsoft.com/playwright:v1.59.1-noble
     │  ◀── download via short-lived ── Blob Storage ◀──stream── + ffmpeg; imports @page-capture/core
            user-delegation SAS         outputs/{id}.mp4         unchanged; writes status/percent
```

## Services

| Concern | Choice | Notes |
|---|---|---|
| Front end | Azure Static Web Apps (or Storage `$web` + Front Door) | pure SPA (Vite + React/Svelte); validates with the shared zod schema |
| HTTP API | small **Container App**, `minReplicas: 1` | validate, enqueue, return `202 {jobId}`; serve `GET /jobs/{id}`; mint input/output SAS. **No captures here.** |
| Queue | Azure Storage Queue | message holds only `{jobId}` (64 KB cap); upgrade to Service Bus for DLQ/FIFO |
| Worker | **Azure Container Apps event-driven Job**, KEDA `azure-queue` trigger | one execution per message, scale-to-zero; image = Playwright base + ffmpeg |
| Output | Azure Blob Storage + lifecycle TTL | worker streams the MP4/GIF straight to a block blob |
| Status | Azure Table Storage | `{jobId, status, percent, phase, error?, blobPath?}` |
| Delivery | **user-delegation SAS** (15–60 min, read-only, HTTPS) | signed via managed identity, no account key; the API never proxies media |

If the Functions *programming model* is required, use **Functions on Container Apps** (`kind=functionapp`, BYO image) or a custom Linux container on **Functions Premium** — never Flex Consumption or the retiring Linux Consumption plan.

## Why these constraints (verified)

- **Containerize Playwright.** Flex Consumption is code-only (no custom container, 4096 MB / 2 vCPU / 0.8 GB temp); Linux Consumption is retiring; Windows Consumption's sandbox blocks Chromium. The reliable path is the official `mcr.microsoft.com/playwright` image (browsers + ~80 OS deps preinstalled) + `apt-get install ffmpeg`.
- **Async, not synchronous.** Functions HTTP triggers have a non-configurable ~230s Azure Load Balancer idle timeout, and there is a 210 MB request/response cap. Never return video bytes inline — write to Blob, hand back a SAS URL. (ACA Envoy ingress defaults to 240s and is configurable up to 30 min via Premium Ingress, but the async pattern is still the correct default.)
- **Pin Playwright == image tag.** `playwright@1.59.1` ↔ `mcr.microsoft.com/playwright:v1.59.1-noble`, or Chromium launch fails with "browser executable not found".

## What Phase 0 already locked in (so this is additive)

- `capture(options, runtime)` with injectable **`output`** (the worker swaps the CLI's file stream for a Blob upload stream — no engine change), **`AbortSignal`** (thread job shutdown / cancel through Playwright *and* ffmpeg), **`onProgress`** (write percent to the status store), **`browserFactory`** and **`ffmpegPath`** (host controls binaries), and a no-op **logger** (core never touches stdout).
- One shared **`CaptureOptionsSchema`** (`@page-capture/shared`) validated at every boundary, plus the `Job` / `JobStatus` contracts the SPA, API, and worker will share.
- The worker **Dockerfile** (`packages/worker/`), already CI-testable today (`npm run test:docker`).

## Phasing

1. **Phase 1 — worker + contract.** Implement `packages/worker` as a KEDA-queue consumer importing `@page-capture/core` unchanged; pipe `capture()` output to a Blob upload stream. Lock the `202 {jobId}` / status contract in `@page-capture/shared` so the SPA and worker build in parallel.
2. **Phase 2 — cloud + SPA.** `infra/` (Bicep/Terraform): ACA environment + Job + Storage Queue + Blob (lifecycle) + Table Storage + always-warm API + ACR + App Insights + managed identity. SPA: form → `POST /jobs` → poll → preview (`<video>` for MP4, size-badged `<img>` for GIF) / download via SAS.

## Security & cost notes

- **SSRF:** the worker renders arbitrary user URLs. Run non-root with a seccomp profile, isolate in a VNet with egress controls, block link-local/metadata/private IP ranges, allow-list where possible, and cap per-job CPU/mem/time.
- **No zombies:** thread one `AbortSignal` through Playwright and the ffmpeg child; tear down in `finally`; run with `--init` to reap PIDs.
- **Back-pressure:** cap Job `maxExecutions`; let the queue absorb spikes (each job ≈ 1 Chromium + 1 ffmpeg). Size replica memory (~4 GiB) and launch Chromium with `--disable-dev-shm-usage`.
- **Idempotency:** key everything by `jobId`, overwrite the same blob path, so queue redelivery never double-charges.
