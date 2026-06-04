# page-capture Chrome Extension Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rebuild `page-capture` as a Chrome MV3 extension that records the user's real tab into a smooth scrolling H.264 MP4 entirely client-side.

**Architecture:** A thin service-worker broker hands a `tabCapture` stream id + a serialized scroll plan to an offscreen document (which owns `getUserMedia` → frame sampling → Mediabunny H.264/MP4 encode → download) and injects a content script (which preps the DOM and drives a wall-clock-eased scroll that samples the shared `motion.ts` frame plan). All pure logic (motion, CFR reclock scheduling, DOM prep) lives in a new browser-safe `@page-capture/scroll-engine` package and is unit-tested; the browser-only glue is verified by a manual E2E fixture.

**Tech Stack:** TypeScript (ESM, `moduleResolution: Bundler`), npm workspaces, [WXT](https://wxt.dev) (MV3 framework), [Mediabunny](https://mediabunny.dev) (WebCodecs encode + MP4 mux), WebCodecs + `MediaStreamTrackProcessor`, `zod` (shared schema), vitest + happy-dom (tests).

**Spec:** `docs/superpowers/specs/2026-06-04-page-capture-extension-design.md`

**Resolved decisions:** fps default **30**, 60 opt-in · build tool **WXT** · legacy `core`/`cli`/`worker` **deleted** after extraction · muxer **Mediabunny** · cross-origin/consent failures **warn + proceed**.

---

## Phase 0 — Workspace restructure

### Task 0.1: Initialise git so commits work

**Files:** none (repo is not yet a git repo)

- [ ] **Step 1: Init the repo and add a gitignore**

```bash
cd /home/george/projects/page-capture
git init
printf 'node_modules\ndist\n.wxt\n.output\n*.zip\n' > .gitignore
git add -A && git commit -m "chore: initialise git repository"
```

Expected: `git log --oneline` shows one commit.

---

### Task 0.2: Create the `@page-capture/scroll-engine` package and move `motion.ts` into it

`motion.ts` is pure (only `import type { EasingName }`) and is the single source of truth for scroll feel. It moves verbatim; only its home changes.

**Files:**
- Create: `packages/scroll-engine/package.json`
- Create: `packages/scroll-engine/tsconfig.json`
- Create: `packages/scroll-engine/src/motion.ts` (moved from `packages/core/src/motion.ts`, byte-identical)
- Create: `packages/scroll-engine/src/index.ts`
- Create: `packages/scroll-engine/test/motion.test.ts` (moved from `packages/core/test/motion.test.ts`)

- [ ] **Step 1: Create the package manifest**

`packages/scroll-engine/package.json`:
```json
{
  "name": "@page-capture/scroll-engine",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "main": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "exports": { ".": { "types": "./dist/index.d.ts", "import": "./dist/index.js" } },
  "files": ["dist"],
  "scripts": { "build": "tsup src/index.ts --format esm --dts --clean" },
  "dependencies": { "@page-capture/shared": "*" }
}
```

`packages/scroll-engine/tsconfig.json`:
```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": { "outDir": "dist", "rootDir": "src" },
  "include": ["src/**/*"]
}
```

- [ ] **Step 2: Move motion.ts and its test verbatim**

```bash
cd /home/george/projects/page-capture
git mv packages/core/src/motion.ts packages/scroll-engine/src/motion.ts
git mv packages/core/test/motion.test.ts packages/scroll-engine/test/motion.test.ts
```

If the test imports from `'../src/motion'` it still resolves (same relative shape). If it imports `@page-capture/core`, change that import to `@page-capture/scroll-engine` (done in Step 4 after the alias exists).

- [ ] **Step 3: Create the barrel**

`packages/scroll-engine/src/index.ts`:
```ts
export * from './motion';
```

- [ ] **Step 4: Point the workspace + vitest alias at the new package**

In `vitest.config.ts`, replace the `@page-capture/core` alias line with:
```ts
      '@page-capture/scroll-engine': r('./packages/scroll-engine/src/index.ts'),
```
(Keep the `@page-capture/shared` alias.) Update `packages/scroll-engine/test/motion.test.ts` imports to `'../src/motion'` or `@page-capture/scroll-engine`.

In root `package.json` `workspaces`, add `"packages/scroll-engine"` (leave others for now; they're removed in Task 0.5).

- [ ] **Step 5: Run the moved test**

Run: `npx vitest run packages/scroll-engine/test/motion.test.ts`
Expected: PASS (same assertions as before the move).

- [ ] **Step 6: Commit**

```bash
git add -A && git commit -m "refactor: extract motion.ts into @page-capture/scroll-engine"
```

---

### Task 0.3: Prune server-only contracts from `@page-capture/shared`

The `Job`/`JobStatus` contracts existed only for the dropped Azure worker.

**Files:**
- Modify: `packages/shared/src/index.ts` (remove the job-contract block at the end)

- [ ] **Step 1: Delete the async-job contracts**

In `packages/shared/src/index.ts`, delete everything from the comment line `// Async job contracts` (≈ line 247) through end of file — i.e. remove `JOB_STATUSES`, `JobState`, `JobStatusSchema`, `JobStatus`, `JobSchema`, `Job`. Keep `CaptureProgress` and everything above it.

- [ ] **Step 2: Verify nothing else references them**

Run: `grep -rn "JobSchema\|JobStatus\|JOB_STATUSES" packages/shared packages/scroll-engine`
Expected: no matches.

- [ ] **Step 3: Typecheck shared in isolation**

Run: `npx tsc -p packages/shared/tsconfig.json --noEmit`
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add -A && git commit -m "refactor: drop server-only Job contracts from shared"
```

---

### Task 0.4: Extract the browser-safe DOM-prep + stops logic into scroll-engine

Port the DOM bodies from `page-prep.ts` and `resolveStops` out of their Playwright wrappers. Layout-dependent pieces take small injectables so they stay unit-testable. (TDD for these lands in Phase 1; here we just create the file skeleton + types so later tasks can import it.)

**Files:**
- Create: `packages/scroll-engine/src/dom-prep.ts`
- Modify: `packages/scroll-engine/src/index.ts` (export it)

- [ ] **Step 1: Create `dom-prep.ts` with the ported signatures (implementations filled by TDD in Phase 1)**

`packages/scroll-engine/src/dom-prep.ts`:
```ts
import type { ScrollStop } from '@page-capture/shared';

/** Common "accept cookies" / consent buttons, tried best-effort (text matched case-insensitively). */
export const DEFAULT_CONSENT_SELECTORS = [
  '#onetrust-accept-btn-handler',
  '#truste-consent-button',
  'button#accept',
  'button[aria-label="Accept all" i]',
];
/** Visible-text buttons to click if no selector matched (lowercased contains-match). */
export const DEFAULT_CONSENT_TEXTS = ['accept all', 'accept', 'i agree', 'got it'];

export function neutralizeLazyImages(doc: Document): Promise<void> {
  for (const img of Array.from(doc.images)) {
    const ds = img.getAttribute('data-src');
    if (ds && !img.getAttribute('src')) img.setAttribute('src', ds);
    const dss = img.getAttribute('data-srcset');
    if (dss && !img.getAttribute('srcset')) img.setAttribute('srcset', dss);
    img.loading = 'eager';
  }
  return Promise.all(
    Array.from(doc.images).map((i) => (i.complete ? Promise.resolve() : i.decode().catch(() => undefined))),
  ).then(() => undefined);
}

export function hideFixedElements(doc: Document): void {
  for (const el of Array.from(doc.querySelectorAll('body *'))) {
    const pos = getComputedStyle(el).position;
    if (pos === 'fixed' || pos === 'sticky') (el as HTMLElement).style.visibility = 'hidden';
  }
}

/** Click the first matching consent control. Returns true if one was clicked. */
export function dismissConsent(doc: Document, userSelectors: string[] = []): boolean {
  for (const sel of [...userSelectors, ...DEFAULT_CONSENT_SELECTORS]) {
    try {
      const el = doc.querySelector<HTMLElement>(sel);
      if (el && el.offsetParent !== null) { el.click(); return true; }
    } catch { /* invalid selector — ignore */ }
  }
  const buttons = Array.from(doc.querySelectorAll<HTMLElement>('button, [role="button"]'));
  for (const text of DEFAULT_CONSENT_TEXTS) {
    const hit = buttons.find((b) => (b.textContent ?? '').trim().toLowerCase() === text);
    if (hit && hit.offsetParent !== null) { hit.click(); return true; }
  }
  return false;
}

/**
 * Poll a height reader until it is stable across `stableReads` consecutive equal
 * reads (lazy content keeps growing it), capped by maxHeightPx. `sleep` and
 * `readHeight` are injected so this is pure-testable.
 */
export async function measureStableHeight(
  readHeight: () => number,
  opts: { maxHeightPx?: number; maxReads?: number; stableReads?: number; sleep: (ms: number) => Promise<void>; intervalMs?: number },
): Promise<number> {
  const maxReads = opts.maxReads ?? 15;
  const need = opts.stableReads ?? 3;
  const interval = opts.intervalMs ?? 80;
  let last = -1, stable = 0, height = 0;
  for (let i = 0; i < maxReads; i++) {
    height = readHeight();
    if (height === last) { if (++stable >= need) break; } else { stable = 0; last = height; }
    await opts.sleep(interval);
  }
  return opts.maxHeightPx ? Math.min(height, opts.maxHeightPx) : height;
}

/**
 * Resolve pause points to scroll offsets (px). Selector → element top + scrollY
 * (via injected measurer, default DOM); offset/percent are arithmetic. Unresolved
 * selectors are reported via onWarn and skipped.
 */
export function resolveStops(
  stops: ScrollStop[] | undefined,
  distance: number,
  onWarn: (msg: string) => void,
  measure: (sel: string) => number | null = (sel) => {
    const el = document.querySelector(sel);
    return el ? Math.round(el.getBoundingClientRect().top + window.scrollY) : null;
  },
): Array<{ offset: number; holdMs?: number }> | undefined {
  if (!stops || stops.length === 0) return undefined;
  const out: Array<{ offset: number; holdMs?: number }> = [];
  for (const s of stops) {
    let offset: number;
    if (s.selector !== undefined) {
      const o = measure(s.selector);
      if (o === null) { onWarn(`stop selector not found, skipping: ${s.selector}`); continue; }
      offset = o;
    } else if (s.offset !== undefined) offset = s.offset;
    else offset = Math.round(((s.percent as number) / 100) * distance);
    out.push(s.holdMs !== undefined ? { offset, holdMs: s.holdMs } : { offset });
  }
  return out.length ? out : undefined;
}
```

- [ ] **Step 2: Export from the barrel**

`packages/scroll-engine/src/index.ts`:
```ts
export * from './motion';
export * from './dom-prep';
export * from './reclock';
```
(`reclock` is created in Phase 1, Task 1.1 — create it before this export resolves, or add the line then.)

- [ ] **Step 3: Commit**

```bash
git add -A && git commit -m "feat(scroll-engine): browser-safe DOM-prep + stops helpers"
```

---

### Task 0.5: Delete the legacy Playwright/ffmpeg packages

Everything browser-safe is now extracted. The Node engine is no longer the product.

**Files:**
- Delete: `packages/core`, `packages/cli`, `packages/worker`, `scripts/generate-samples.ts`, `samples/`
- Modify: root `package.json`, root `tsconfig.json`, `vitest.config.ts`

- [ ] **Step 1: Remove the packages**

```bash
cd /home/george/projects/page-capture
git rm -r packages/core packages/cli packages/worker scripts samples
```

- [ ] **Step 2: Update root `package.json`**

Replace `workspaces`, `scripts`, and `devDependencies` so the dead toolchain is gone:
```jsonc
{
  "name": "page-capture-monorepo",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "engines": { "node": ">=22" },
  "workspaces": ["packages/shared", "packages/scroll-engine", "packages/extension"],
  "scripts": {
    "build": "npm run build --workspace=@page-capture/shared --workspace=@page-capture/scroll-engine --if-present && npm run build --workspace=@page-capture/extension --if-present",
    "dev": "npm run dev --workspace=@page-capture/extension",
    "zip": "npm run zip --workspace=@page-capture/extension",
    "typecheck": "tsc -p tsconfig.json --noEmit",
    "test": "vitest run",
    "test:watch": "vitest"
  },
  "devDependencies": {
    "@types/node": "^24.0.0",
    "happy-dom": "^15.0.0",
    "tsup": "^8.3.5",
    "typescript": "^5.7.2",
    "vitest": "^3.0.0"
  }
}
```
(`packages/extension` is created in Phase 2; `--if-present` keeps build green until then.)

- [ ] **Step 3: Update root `tsconfig.json` paths**

Replace the `@page-capture/core` path with scroll-engine:
```json
    "paths": {
      "@page-capture/shared": ["packages/shared/src/index.ts"],
      "@page-capture/scroll-engine": ["packages/scroll-engine/src/index.ts"]
    }
```

- [ ] **Step 4: Reinstall to drop removed deps from the lockfile**

Run: `npm install`
Expected: completes; `playwright`, `ffmpeg-static`, `sharp`, `playwright-core` no longer in `node_modules/.package-lock.json` top level.

- [ ] **Step 5: Verify the suite is green and typecheck passes**

Run: `npx vitest run` then `npm run typecheck`
Expected: only `scroll-engine` (motion) + `shared` tests run, all PASS; typecheck clean.

- [ ] **Step 6: Commit**

```bash
git add -A && git commit -m "chore: delete legacy Playwright/ffmpeg packages"
```

---

## Phase 1 — scroll-engine pure logic (TDD)

### Task 1.1: `frameAtElapsed` — wall-clock → scroll frame index

The content-script driver samples the frame plan by elapsed time instead of stepping it.

**Files:**
- Create: `packages/scroll-engine/src/reclock.ts`
- Create: `packages/scroll-engine/test/reclock.test.ts`

- [ ] **Step 1: Write the failing test**

`packages/scroll-engine/test/reclock.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { frameAtElapsed } from '../src/reclock';

describe('frameAtElapsed', () => {
  it('maps elapsed wall-clock to the nearest frame index at the given fps', () => {
    expect(frameAtElapsed(0, 30, 100)).toBe(0);
    expect(frameAtElapsed(1000, 30, 100)).toBe(30); // 1s @30fps = frame 30
    expect(frameAtElapsed(16, 60, 100)).toBe(1);    // ~one 60fps frame
  });
  it('clamps to [0, totalFrames-1]', () => {
    expect(frameAtElapsed(-50, 30, 100)).toBe(0);
    expect(frameAtElapsed(999_999, 30, 100)).toBe(99);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run packages/scroll-engine/test/reclock.test.ts`
Expected: FAIL — `frameAtElapsed is not a function` / module not found.

- [ ] **Step 3: Implement**

`packages/scroll-engine/src/reclock.ts`:
```ts
/** Frame index to display after `elapsedMs` of a capture at `fps`, clamped to the plan length. */
export function frameAtElapsed(elapsedMs: number, fps: number, totalFrames: number): number {
  const idx = Math.round((elapsedMs * fps) / 1000);
  return Math.min(totalFrames - 1, Math.max(0, idx));
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run packages/scroll-engine/test/reclock.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat(scroll-engine): frameAtElapsed time→frame mapping"
```

---

### Task 1.2: `buildSampleSchedule` — VFR→CFR frame sampling (duplicate/drop)

This is the precise, testable specification of the CFR reclock: for each fixed output slot, which captured frame is shown. The offscreen pump realises the same semantics in real time.

**Files:**
- Modify: `packages/scroll-engine/src/reclock.ts`
- Modify: `packages/scroll-engine/test/reclock.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `packages/scroll-engine/test/reclock.test.ts`:
```ts
import { buildSampleSchedule } from '../src/reclock';

describe('buildSampleSchedule (VFR→CFR)', () => {
  it('holds the latest captured frame across empty slots (duplicate to fill)', () => {
    // frames arrive at 0ms and 100ms; 30fps slots are every 33.33ms; 5 slots.
    // slot times: 0,33,67,100,133 → frame0,frame0,frame0,frame1,frame1
    expect(buildSampleSchedule([0, 100], 5, 30)).toEqual([0, 0, 0, 1, 1]);
  });
  it('drops extra frames that arrive within one slot (only latest ≤ slot time wins)', () => {
    // many frames within the first 33ms; at 30fps slot 0 (t=0) sees frame 0 only,
    // slot 1 (t≈33) sees the last frame ≤33ms.
    expect(buildSampleSchedule([0, 5, 10, 40], 2, 30)).toEqual([0, 2]);
  });
  it('uses frame 0 for slots before the first frame arrives', () => {
    expect(buildSampleSchedule([50], 3, 30)).toEqual([0, 0, 0]);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run packages/scroll-engine/test/reclock.test.ts -t "VFR"`
Expected: FAIL — `buildSampleSchedule is not a function`.

- [ ] **Step 3: Implement**

Append to `packages/scroll-engine/src/reclock.ts`:
```ts
/**
 * For each of `totalFrames` constant-rate output slots at `fps`, return the index
 * (into `frameTimesMs`) of the captured frame that was latest at that slot's time
 * (slot n at n*1000/fps ms). Frames with no earlier capture use index 0. This is
 * "sample the latest live frame at a fixed rate": empty slots duplicate the held
 * frame, bursts drop all but the latest. Pure + deterministic for unit testing.
 */
export function buildSampleSchedule(frameTimesMs: number[], totalFrames: number, fps: number): number[] {
  const slotMs = 1000 / fps;
  const out: number[] = new Array(totalFrames);
  let fi = 0;
  for (let n = 0; n < totalFrames; n++) {
    const slotTime = n * slotMs;
    while (fi + 1 < frameTimesMs.length && frameTimesMs[fi + 1]! <= slotTime) fi++;
    out[n] = frameTimesMs.length === 0 ? 0 : fi;
  }
  return out;
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run packages/scroll-engine/test/reclock.test.ts`
Expected: PASS (all reclock tests).

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat(scroll-engine): buildSampleSchedule VFR→CFR reclock spec"
```

---

### Task 1.3: TDD the DOM-prep helpers (happy-dom)

Validate the non-layout behaviour of the helpers created in Task 0.4. Layout-dependent paths (real element positions) are covered in the Phase 4 manual E2E.

**Files:**
- Create: `packages/scroll-engine/test/dom-prep.test.ts`

- [ ] **Step 1: Write the failing tests**

`packages/scroll-engine/test/dom-prep.test.ts`:
```ts
// @vitest-environment happy-dom
import { describe, expect, it, vi } from 'vitest';
import {
  dismissConsent,
  hideFixedElements,
  measureStableHeight,
  neutralizeLazyImages,
  resolveStops,
} from '../src/dom-prep';

describe('neutralizeLazyImages', () => {
  it('promotes data-src/data-srcset to src/srcset and sets eager loading', async () => {
    document.body.innerHTML = `<img data-src="a.jpg" data-srcset="a-2x.jpg 2x">`;
    const img = document.images[0]!;
    await neutralizeLazyImages(document);
    expect(img.getAttribute('src')).toBe('a.jpg');
    expect(img.getAttribute('srcset')).toBe('a-2x.jpg 2x');
    expect(img.loading).toBe('eager');
  });
});

describe('hideFixedElements', () => {
  it('hides fixed/sticky elements only', () => {
    document.body.innerHTML =
      `<div id="f" style="position:fixed"></div><div id="s" style="position:sticky"></div><div id="n" style="position:static"></div>`;
    hideFixedElements(document);
    expect((document.getElementById('f') as HTMLElement).style.visibility).toBe('hidden');
    expect((document.getElementById('s') as HTMLElement).style.visibility).toBe('hidden');
    expect((document.getElementById('n') as HTMLElement).style.visibility).toBe('');
  });
});

describe('dismissConsent', () => {
  it('clicks a button matching consent text and reports it', () => {
    document.body.innerHTML = `<button>Accept all</button>`;
    const btn = document.querySelector('button')!;
    const spy = vi.fn();
    btn.addEventListener('click', spy);
    expect(dismissConsent(document)).toBe(true);
    expect(spy).toHaveBeenCalledOnce();
  });
  it('returns false when nothing matches', () => {
    document.body.innerHTML = `<button>Subscribe</button>`;
    expect(dismissConsent(document)).toBe(false);
  });
});

describe('measureStableHeight', () => {
  it('returns the height once it is stable for N reads', async () => {
    const seq = [100, 200, 200, 200, 200];
    let i = 0;
    const h = await measureStableHeight(() => seq[Math.min(i++, seq.length - 1)]!, {
      stableReads: 3, sleep: () => Promise.resolve(),
    });
    expect(h).toBe(200);
  });
  it('caps at maxHeightPx', async () => {
    const h = await measureStableHeight(() => 5000, { maxHeightPx: 1200, sleep: () => Promise.resolve() });
    expect(h).toBe(1200);
  });
});

describe('resolveStops', () => {
  it('resolves offset and percent arithmetically', () => {
    const warn = vi.fn();
    expect(resolveStops([{ offset: 640 }, { percent: 50 }], 1000, warn)).toEqual([{ offset: 640 }, { offset: 500 }]);
    expect(warn).not.toHaveBeenCalled();
  });
  it('skips and warns on an unresolved selector, keeps holdMs', () => {
    const warn = vi.fn();
    const out = resolveStops(
      [{ selector: '#missing' }, { offset: 100, holdMs: 2000 }],
      1000, warn, () => null,
    );
    expect(out).toEqual([{ offset: 100, holdMs: 2000 }]);
    expect(warn).toHaveBeenCalledOnce();
  });
});
```

- [ ] **Step 2: Run to verify failure shape**

Run: `npx vitest run packages/scroll-engine/test/dom-prep.test.ts`
Expected: tests RUN under happy-dom and PASS immediately if Task 0.4's implementations are correct. If any fail, fix the implementation in `dom-prep.ts` (not the test). (These functions were written in 0.4 but never executed — this is the first time they run; treat a failure as the red→green signal.)

- [ ] **Step 3: Ensure all pass**

Run: `npx vitest run packages/scroll-engine/test/dom-prep.test.ts`
Expected: PASS (all groups).

- [ ] **Step 4: Typecheck + full suite + commit**

```bash
npm run typecheck && npx vitest run
git add -A && git commit -m "test(scroll-engine): cover DOM-prep helpers under happy-dom"
```
Expected: typecheck clean; all scroll-engine + shared tests PASS.

---

## Phase 2 — Extension scaffold (WXT)

### Task 2.1: Scaffold the `@page-capture/extension` WXT package

**Files:**
- Create: `packages/extension/package.json`
- Create: `packages/extension/wxt.config.ts`
- Create: `packages/extension/tsconfig.json`
- Create: `packages/extension/entrypoints/background.ts` (stub)

- [ ] **Step 1: Create the package manifest**

`packages/extension/package.json`:
```json
{
  "name": "@page-capture/extension",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "wxt",
    "build": "wxt build",
    "zip": "wxt zip",
    "postinstall": "wxt prepare",
    "typecheck": "wxt prepare && tsc --noEmit"
  },
  "dependencies": {
    "@page-capture/shared": "*",
    "@page-capture/scroll-engine": "*",
    "mediabunny": "^1.0.0"
  },
  "devDependencies": {
    "@types/dom-mediacapture-transform": "^0.1.10",
    "typescript": "^5.7.2",
    "wxt": "^0.20.0"
  }
}
```

- [ ] **Step 2: Configure WXT, manifest permissions, and the offscreen-capable build**

`packages/extension/wxt.config.ts`:
```ts
import { defineConfig } from 'wxt';

export default defineConfig({
  manifest: {
    name: 'Page Capture — scroll to MP4',
    description: 'Record the current tab scrolling into a smooth MP4 for slide decks.',
    permissions: ['tabCapture', 'offscreen', 'activeTab', 'scripting', 'downloads'],
    host_permissions: ['http://*/*', 'https://*/*'],
  },
});
```

`packages/extension/tsconfig.json`:
```json
{ "extends": "./.wxt/tsconfig.json" }
```

- [ ] **Step 3: Background stub**

`packages/extension/entrypoints/background.ts`:
```ts
export default defineBackground(() => {
  // wired up in Task 3.3
});
```

- [ ] **Step 4: Install and prepare**

Run: `cd /home/george/projects/page-capture && npm install`
Then: `npm run dev --workspace=@page-capture/extension -- --help` *(or just `npx wxt prepare` inside the package)*
Expected: WXT generates `.wxt/` types; no errors.

- [ ] **Step 5: Build the (empty) extension**

Run: `npm run build --workspace=@page-capture/extension`
Expected: `.output/chrome-mv3/manifest.json` produced with the declared permissions.

- [ ] **Step 6: Commit**

```bash
git add -A && git commit -m "feat(extension): scaffold WXT MV3 package"
```

---

### Task 2.2: Typed message protocol + serialized plan

A single typed contract for SW ↔ content ↔ offscreen messaging, and the serializable scroll plan the content script computes and hands to the offscreen doc.

**Files:**
- Create: `packages/extension/src/messages.ts`
- Create: `packages/extension/test/messages.test.ts`

- [ ] **Step 1: Write the failing test (guards the discriminated union shape)**

`packages/extension/test/messages.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { isMessage, type Msg } from '../src/messages';

describe('isMessage', () => {
  it('accepts a well-formed start message and rejects junk', () => {
    const m: Msg = { type: 'capture:start', streamId: 's', fps: 30, totalFrames: 90, width: 1920, height: 1080 };
    expect(isMessage(m)).toBe(true);
    expect(isMessage({ type: 'nope' })).toBe(false);
    expect(isMessage(null)).toBe(false);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run packages/extension/test/messages.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the protocol**

`packages/extension/src/messages.ts`:
```ts
export type Msg =
  // popup → background
  | { type: 'ui:start'; options: unknown } // options validated by zod in the popup
  // background → content
  | { type: 'drive:start'; fps: number; options: unknown }
  // content → background (plan measured) ; background → offscreen
  | { type: 'capture:start'; streamId: string; fps: number; totalFrames: number; width: number; height: number }
  // content → offscreen (per-frame nothing; offscreen samples its own stream) ; content → background
  | { type: 'drive:done' }
  | { type: 'drive:progress'; frame: number; totalFrames: number }
  // offscreen → background → popup
  | { type: 'capture:done'; ok: true; encoder: string } | { type: 'capture:done'; ok: false; error: string }
  | { type: 'capture:progress'; frame: number; totalFrames: number }
  | { type: 'abort' };

const TYPES = new Set<Msg['type']>([
  'ui:start', 'drive:start', 'capture:start', 'drive:done', 'drive:progress',
  'capture:done', 'capture:progress', 'abort',
]);

export function isMessage(x: unknown): x is Msg {
  return typeof x === 'object' && x !== null && TYPES.has((x as { type?: Msg['type'] }).type as Msg['type']);
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run packages/extension/test/messages.test.ts`
Expected: PASS.

- [ ] **Step 5: Add the extension alias to vitest + commit**

In `vitest.config.ts` add:
```ts
      '@page-capture/extension': r('./packages/extension/src/index.ts'),
```
*(create `packages/extension/src/index.ts` with `export * from './messages';` so the alias resolves)*. Then:
```bash
npx vitest run packages/extension && git add -A && git commit -m "feat(extension): typed message protocol"
```

---

## Phase 3 — Extension runtime glue (browser-only; verified in Phase 4)

> These tasks produce browser-only code that cannot run under vitest (they use `tabCapture`, `getUserMedia`, WebCodecs). Each task's verification is **typecheck + build**; behavioural verification is the Phase 4 manual E2E. Commit after each.

### Task 3.1: Offscreen encoder — sample the tab stream into a CFR H.264 MP4

**Files:**
- Create: `packages/extension/src/encoder.ts`
- Create: `packages/extension/entrypoints/offscreen.html`
- Create: `packages/extension/entrypoints/offscreen.ts`

- [ ] **Step 1: The encoder (Mediabunny CanvasSource + real-time CFR pump)**

`packages/extension/src/encoder.ts`:
```ts
import { Output, Mp4OutputFormat, BufferTarget, CanvasSource, canEncodeVideo } from 'mediabunny';

export interface EncodeParams {
  track: MediaStreamVideoTrack;
  width: number;
  height: number;
  fps: number;
  totalFrames: number;
  bitrate?: number;
  signal: AbortSignal;
  onProgress?: (frame: number) => void;
}
export interface EncodeResult { buffer: ArrayBuffer; encoder: string }

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Read the live tab track, and on a fixed 1/fps clock draw the latest received
 * frame to a canvas and add it to the muxer with an exact CFR timestamp.
 * Empty slots duplicate the held frame; bursts are dropped (latest wins) — the
 * real-time realisation of buildSampleSchedule.
 */
export async function encodeTabStream(p: EncodeParams): Promise<EncodeResult> {
  const bitrate = p.bitrate ?? 14_000_000;
  if (!(await canEncodeVideo('avc', { width: p.width, height: p.height, bitrate }))) {
    throw new Error('H.264 (avc) encoding not supported on this machine');
  }
  const canvas = new OffscreenCanvas(p.width, p.height);
  const ctx = canvas.getContext('2d', { alpha: false })!;
  const output = new Output({ format: new Mp4OutputFormat({ fastStart: 'in-memory' }), target: new BufferTarget() });
  const source = new CanvasSource(canvas as unknown as HTMLCanvasElement, { codec: 'avc', bitrate });
  output.addVideoTrack(source, { frameRate: p.fps });
  await output.start();

  const reader = (new MediaStreamTrackProcessor({ track: p.track }).readable).getReader();
  let latest: VideoFrame | null = null;
  let reading = true;
  const pump = (async () => {
    while (reading) {
      const { value, done } = await reader.read();
      if (done) break;
      latest?.close();
      latest = value;
    }
  })();

  const slotMs = 1000 / p.fps;
  const t0 = performance.now();
  try {
    for (let n = 0; n < p.totalFrames; n++) {
      if (p.signal.aborted) throw new Error('aborted');
      const due = t0 + n * slotMs;
      const wait = due - performance.now();
      if (wait > 0) await sleep(wait);
      if (latest) ctx.drawImage(latest, 0, 0, p.width, p.height);
      await source.add(n / p.fps, 1 / p.fps);
      p.onProgress?.(n + 1);
    }
  } finally {
    reading = false;
    reader.cancel().catch(() => undefined);
    await pump.catch(() => undefined);
    latest?.close();
    p.track.stop();
  }
  await output.finalize();
  return { buffer: output.target.buffer!, encoder: 'webcodecs-avc' };
}
```

- [ ] **Step 2: Offscreen document host**

`packages/extension/entrypoints/offscreen.html`:
```html
<!doctype html>
<html><head><meta charset="utf-8"><title>page-capture offscreen</title></head>
<body><script type="module" src="./offscreen.ts"></script></body></html>
```

`packages/extension/entrypoints/offscreen.ts`:
```ts
import { isMessage } from '../src/messages';
import { encodeTabStream } from '../src/encoder';

const controller = { abort: new AbortController() };

chrome.runtime.onMessage.addListener((raw) => {
  if (!isMessage(raw)) return;
  if (raw.type === 'abort') { controller.abort.abort(); return; }
  if (raw.type !== 'capture:start') return;
  void run(raw);
});

async function run(m: Extract<import('../src/messages').Msg, { type: 'capture:start' }>): Promise<void> {
  controller.abort = new AbortController();
  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      video: { mandatory: { chromeMediaSource: 'tab', chromeMediaSourceId: m.streamId,
        maxWidth: m.width, maxHeight: m.height, maxFrameRate: m.fps } } as MediaTrackConstraints,
    });
    const track = stream.getVideoTracks()[0] as MediaStreamVideoTrack;
    const { buffer, encoder } = await encodeTabStream({
      track, width: m.width, height: m.height, fps: m.fps, totalFrames: m.totalFrames,
      signal: controller.abort.signal,
      onProgress: (frame) => chrome.runtime.sendMessage({ type: 'capture:progress', frame, totalFrames: m.totalFrames }),
    });
    const url = URL.createObjectURL(new Blob([buffer], { type: 'video/mp4' }));
    await chrome.downloads.download({ url, filename: 'page-capture.mp4', saveAs: true });
    chrome.runtime.sendMessage({ type: 'capture:done', ok: true, encoder });
  } catch (e) {
    chrome.runtime.sendMessage({ type: 'capture:done', ok: false, error: (e as Error).message });
  }
}
```

- [ ] **Step 3: Typecheck + build**

Run: `npm run typecheck --workspace=@page-capture/extension && npm run build --workspace=@page-capture/extension`
Expected: clean. (If `MediaStreamTrackProcessor` is unknown, confirm `@types/dom-mediacapture-transform` is installed and in tsconfig `types`/lib.)

- [ ] **Step 4: Commit**

```bash
git add -A && git commit -m "feat(extension): offscreen tab-stream → CFR H.264 MP4 encoder"
```

---

### Task 3.2: Content script — DOM prep + wall-clock eased scroll driver

**Files:**
- Create: `packages/extension/entrypoints/content.ts`

- [ ] **Step 1: Implement the driver**

`packages/extension/entrypoints/content.ts`:
```ts
import { CaptureOptionsSchema } from '@page-capture/shared';
import {
  buildFramePlan, frameAtElapsed, dismissConsent, hideFixedElements,
  measureStableHeight, neutralizeLazyImages, resolveStops,
} from '@page-capture/scroll-engine';
import { isMessage } from '../src/messages';

export default defineContentScript({
  matches: ['http://*/*', 'https://*/*'],
  registration: 'manifest',
  runAt: 'document_idle',
  main() {
    chrome.runtime.onMessage.addListener((raw, _sender, sendResponse) => {
      if (!isMessage(raw) || raw.type !== 'drive:start') return;
      void prepareAndReportPlan(raw.fps, raw.options).then(sendResponse);
      return true; // async response
    });
    chrome.runtime.onMessage.addListener((raw) => {
      if (isMessage(raw) && raw.type === 'capture:start') void drive(raw.fps, lastPlan!);
    });
  },
});

let lastPlan: { totalFrames: number; offsetForFrame: (i: number) => number } | null = null;

async function prepareAndReportPlan(fps: number, rawOptions: unknown) {
  const opts = CaptureOptionsSchema.parse(rawOptions);
  document.documentElement.style.setProperty('scroll-behavior', 'auto', 'important');
  if (document.fonts) await document.fonts.ready.catch(() => undefined);
  dismissConsent(document, opts.waits.selectors ?? []);
  if (opts.hideFixed) hideFixedElements(document);
  await neutralizeLazyImages(document);
  const viewportHeight = window.innerHeight;
  const contentHeight = await measureStableHeight(
    () => document.documentElement.scrollHeight,
    { ...(opts.maxHeightPx !== undefined ? { maxHeightPx: opts.maxHeightPx } : {}),
      sleep: (ms) => new Promise((r) => setTimeout(r, ms)) },
  );
  const distance = Math.max(0, Math.round(contentHeight - viewportHeight));
  const stops = resolveStops(opts.stops, distance, (msg) => console.warn('page-capture:', msg));
  const plan = buildFramePlan({
    contentHeight, viewportHeight, fps, scrollSpeed: opts.scrollSpeed,
    ...(opts.duration !== undefined ? { duration: opts.duration } : {}),
    minDurationS: opts.minDurationS, maxDurationS: opts.maxDurationS,
    holdStartMs: opts.holds.startMs, holdEndMs: opts.holds.endMs, easing: opts.easing,
    style: opts.scrollStyle, roundTrip: opts.roundTrip,
    pageHoldMs: opts.pageHoldMs, pageScrollMs: opts.pageScrollMs, pageFraction: opts.pageFraction,
    ...(stops ? { stops } : {}),
  });
  lastPlan = { totalFrames: plan.totalFrames, offsetForFrame: plan.offsetForFrame };
  return { totalFrames: plan.totalFrames, width: window.innerWidth, height: viewportHeight };
}

async function drive(fps: number, plan: { totalFrames: number; offsetForFrame: (i: number) => number }) {
  window.scrollTo(0, 0);
  await new Promise((r) => requestAnimationFrame(() => r(undefined)));
  const t0 = performance.now();
  await new Promise<void>((resolve) => {
    const tick = () => {
      const frame = frameAtElapsed(performance.now() - t0, fps, plan.totalFrames);
      window.scrollTo(0, plan.offsetForFrame(frame));
      chrome.runtime.sendMessage({ type: 'drive:progress', frame, totalFrames: plan.totalFrames });
      if (frame >= plan.totalFrames - 1) { resolve(); return; }
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
  chrome.runtime.sendMessage({ type: 'drive:done' });
}
```

- [ ] **Step 2: Typecheck + build + commit**

```bash
npm run typecheck --workspace=@page-capture/extension && npm run build --workspace=@page-capture/extension
git add -A && git commit -m "feat(extension): content-script DOM prep + wall-clock scroll driver"
```
Expected: clean build.

---

### Task 3.3: Background broker — orchestrate the gesture → capture flow

**Files:**
- Modify: `packages/extension/entrypoints/background.ts`

- [ ] **Step 1: Implement the broker**

`packages/extension/entrypoints/background.ts`:
```ts
import { isMessage, type Msg } from '../src/messages';

async function ensureOffscreen(): Promise<void> {
  const has = await chrome.offscreen.hasDocument();
  if (has) return;
  await chrome.offscreen.createDocument({
    url: 'offscreen.html',
    reasons: [chrome.offscreen.Reason.USER_MEDIA],
    justification: 'Encode the captured tab video to MP4.',
  });
}

export default defineBackground(() => {
  // The toolbar click is the required user gesture for tabCapture.
  chrome.action.onClicked.addListener(() => { void chrome.action.openPopup().catch(() => undefined); });

  chrome.runtime.onMessage.addListener((raw, _s, sendResponse) => {
    if (!isMessage(raw) || raw.type !== 'ui:start') return;
    void start(raw.options).then(() => sendResponse({ ok: true }), (e) => sendResponse({ ok: false, error: String(e) }));
    return true;
  });

  // Relay capture progress/done from offscreen to the popup (popup also listens directly).
});

async function start(options: unknown): Promise<void> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) throw new Error('no active tab');
  const fps = readFps(options);

  // 1) get a media stream id for THIS tab (user-gesture path via the popup button).
  const streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: tab.id });

  // 2) make sure the offscreen doc exists.
  await ensureOffscreen();

  // 3) ask the content script to prep + measure the plan.
  const plan = (await chrome.tabs.sendMessage(tab.id, { type: 'drive:start', fps, options } satisfies Msg)) as
    { totalFrames: number; width: number; height: number };

  // 4) tell offscreen to begin capturing/encoding…
  await chrome.runtime.sendMessage({
    type: 'capture:start', streamId, fps, totalFrames: plan.totalFrames, width: plan.width, height: plan.height,
  } satisfies Msg);

  // 5) …and the content script to start scrolling.
  await chrome.tabs.sendMessage(tab.id, { type: 'capture:start', streamId, fps, totalFrames: plan.totalFrames, width: plan.width, height: plan.height } satisfies Msg);
}

function readFps(options: unknown): number {
  const f = (options as { fps?: unknown }).fps;
  return typeof f === 'number' && f > 0 ? f : 30;
}
```

- [ ] **Step 2: Typecheck + build + commit**

```bash
npm run typecheck --workspace=@page-capture/extension && npm run build --workspace=@page-capture/extension
git add -A && git commit -m "feat(extension): background broker for the capture flow"
```

---

### Task 3.4: Popup — options form + Start + progress

**Files:**
- Create: `packages/extension/entrypoints/popup.html`
- Create: `packages/extension/entrypoints/popup/main.ts`

- [ ] **Step 1: Minimal popup markup**

`packages/extension/entrypoints/popup.html`:
```html
<!doctype html>
<html><head><meta charset="utf-8"><title>Page Capture</title>
<style>body{font:13px system-ui;width:260px;padding:12px}label{display:block;margin:6px 0}
input,select{width:100%}#go{margin-top:10px;width:100%;padding:6px}#status{margin-top:8px;color:#555}</style>
</head><body>
  <label>Style <select id="style"><option value="reading">reading</option><option value="continuous">continuous</option></select></label>
  <label>FPS <select id="fps"><option>30</option><option>60</option></select></label>
  <label><input type="checkbox" id="roundTrip"> round trip</label>
  <button id="go">Record this tab</button>
  <div id="status"></div>
  <script type="module" src="./popup/main.ts"></script>
</body></html>
```

- [ ] **Step 2: Popup logic (validates with the shared schema, kicks off, shows progress)**

`packages/extension/entrypoints/popup/main.ts`:
```ts
import { CaptureOptionsSchema } from '@page-capture/shared';
import { isMessage } from '../../src/messages';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const status = $('status') as HTMLDivElement;

chrome.runtime.onMessage.addListener((raw) => {
  if (!isMessage(raw)) return;
  if (raw.type === 'capture:progress') status.textContent = `Encoding ${raw.frame}/${raw.totalFrames}…`;
  if (raw.type === 'capture:done') status.textContent = raw.ok ? `Done (${raw.encoder}).` : `Failed: ${raw.error}`;
});

$('go').addEventListener('click', async () => {
  const parsed = CaptureOptionsSchema.safeParse({
    input: { kind: 'url', url: 'https://placeholder.local/' }, // input is unused by the extension; satisfies the schema
    fps: Number(($('fps') as HTMLSelectElement).value),
    scrollStyle: ($('style') as HTMLSelectElement).value,
    roundTrip: ($('roundTrip') as HTMLInputElement).checked,
  });
  if (!parsed.success) { status.textContent = parsed.error.issues[0]?.message ?? 'invalid options'; return; }
  status.textContent = 'Starting… keep this tab in front.';
  const res = (await chrome.runtime.sendMessage({ type: 'ui:start', options: parsed.data })) as { ok: boolean; error?: string };
  if (!res?.ok) status.textContent = `Error: ${res?.error ?? 'unknown'}`;
});
```

> Note: `CaptureOptionsSchema` requires an `input`. The extension ignores it (it captures the active tab), so the popup passes a placeholder URL to satisfy validation. *(Optional cleanup task later: make `input` optional in the schema for the extension surface.)*

- [ ] **Step 3: Typecheck + build + commit**

```bash
npm run typecheck --workspace=@page-capture/extension && npm run build --workspace=@page-capture/extension
git add -A && git commit -m "feat(extension): popup options form + progress"
```

---

## Phase 4 — Robustness, manual E2E, polish

### Task 4.1: Encoder fallback ladder + surface which path ran

**Files:**
- Modify: `packages/extension/src/encoder.ts`

- [ ] **Step 1: Add a software→MediaRecorder ladder**

In `encodeTabStream`, replace the hard `throw` when `canEncodeVideo('avc', …)` is false with a fallback: try `getFirstEncodableVideoCodec(['avc'], { width, height, bitrate })`; if still null, fall back to a `MediaRecorder`-based WebM recording of the same stream (VFR floor) and return `{ encoder: 'mediarecorder-webm' }` with a `.webm` download name. Keep the WebCodecs/CFR path as the default. Concretely:
```ts
import { getFirstEncodableVideoCodec } from 'mediabunny';
// …at the top of encodeTabStream, after computing bitrate:
const codec = (await canEncodeVideo('avc', { width: p.width, height: p.height, bitrate }))
  ? 'avc'
  : await getFirstEncodableVideoCodec(['avc'], { width: p.width, height: p.height, bitrate });
if (!codec) return recordWithMediaRecorder(p); // VFR WebM floor (implement as a sibling fn)
```
Add `recordWithMediaRecorder(p)` that pipes `new MediaStream([p.track])` into `new MediaRecorder(stream, { mimeType })` (prefer `video/mp4;codecs=avc1.42E01E` via `MediaRecorder.isTypeSupported`, else `video/webm;codecs=vp9`), stops after `p.totalFrames / p.fps` seconds, and resolves `{ buffer, encoder: 'mediarecorder-<container>' }`. The offscreen download name picks `.mp4`/`.webm` from `encoder`.

- [ ] **Step 2: Typecheck + build**

Run: `npm run typecheck --workspace=@page-capture/extension && npm run build --workspace=@page-capture/extension`
Expected: clean.

- [ ] **Step 3: Commit**

```bash
git add -A && git commit -m "feat(extension): encoder fallback ladder (HW→SW→MediaRecorder)"
```

---

### Task 4.2: Abort + focus/visibility-loss safety

**Files:**
- Modify: `packages/extension/entrypoints/offscreen.ts`
- Modify: `packages/extension/entrypoints/content.ts`

- [ ] **Step 1: Track end + visibility guards (offscreen)**

In `offscreen.ts`, after obtaining `track`, add `track.addEventListener('ended', () => controller.abort.abort())` so a tab navigation/close finalises cleanly rather than hanging.

- [ ] **Step 2: Visibility/focus guard (content)**

In `content.ts` `drive()`, before the rAF loop add a `visibilitychange` listener: if `document.visibilityState === 'hidden'`, send `{ type: 'abort' }` and reject the drive promise with a clear message ("tab left foreground — capture aborted"). Remove the listener on completion.

- [ ] **Step 3: Typecheck + build + commit**

```bash
npm run typecheck --workspace=@page-capture/extension && npm run build --workspace=@page-capture/extension
git add -A && git commit -m "feat(extension): abort on track-end and foreground loss"
```

---

### Task 4.3: Preconditions — zoom normalize + ≥60Hz warning

**Files:**
- Modify: `packages/extension/entrypoints/content.ts`
- Modify: `packages/extension/entrypoints/popup/main.ts`

- [ ] **Step 1: Normalize zoom (background, before measuring)**

In `background.ts` `start()`, before messaging the content script, call `await chrome.tabs.setZoom(tab.id, 1)` so `devicePixelRatio` reflects native 1080p. *(Requires no extra permission for the active tab.)*

- [ ] **Step 2: 60Hz heads-up (popup)**

In `popup/main.ts`, when fps `60` is selected, if `window.screen` refresh can't be confirmed, show a non-blocking note: "60fps needs a 60Hz+ display; otherwise it falls back to smooth ~30." (Informational only — capture still proceeds.)

- [ ] **Step 3: Typecheck + build + commit**

```bash
npm run typecheck --workspace=@page-capture/extension && npm run build --workspace=@page-capture/extension
git add -A && git commit -m "feat(extension): normalize zoom + 60Hz heads-up"
```

---

### Task 4.4: Manual E2E fixture + verification checklist

**Files:**
- Create: `packages/extension/e2e/fixture.html` (self-contained: CSS reveal + a WebGL canvas + a small non-DRM `<video>`)
- Create: `packages/extension/e2e/README.md` (the manual checklist)

- [ ] **Step 1: Build a fixture page exercising all three fidelity axes**

`packages/extension/e2e/fixture.html`: a tall page (≈ 4× viewport) with (a) several sections that fade/translate in via `IntersectionObserver` adding a class, (b) a `<canvas>` running a continuous WebGL (or 2D fallback) animation, (c) a short looping muted non-DRM `<video>` (e.g. an inline `data:`/local webm). Each section labelled so the filmstrip is legible.

- [ ] **Step 2: Write the manual checklist**

`packages/extension/e2e/README.md` — steps:
1. `npm run dev --workspace=@page-capture/extension` → load `.output/chrome-mv3` as an unpacked extension in real Chrome (`chrome://extensions`, Developer mode → Load unpacked).
2. Serve the fixture (`npx serve packages/extension/e2e`) and open it in a tab; keep the tab foreground.
3. Click the toolbar button → choose reading style, 30fps → Record.
4. Verify the downloaded `page-capture.mp4`: opens in PowerPoint/Keynote/QuickTime; reveals animate (not pre-revealed); WebGL canvas moves; `<video>` plays; text is crisp at 1080p; scroll is smooth; duration ≈ `totalFrames/fps`.
5. Repeat at 60fps and on hexagon.com (foreground); confirm Cloudflare is a non-issue and reveals look natural.
6. Note the reported encoder path (`webcodecs-avc` expected on a capable machine).

- [ ] **Step 3: Commit**

```bash
git add -A && git commit -m "test(extension): manual E2E fixture + verification checklist"
```

- [ ] **Step 4: Execute the checklist and record results**

Run the checklist on a GPU-capable Chrome (not the WSL2 dev box). Capture any deviations as follow-up issues. *(This is the behavioural sign-off the unit tests can't provide.)*

---

## Self-review notes (coverage of the spec)

- **§3 architecture (SW broker / offscreen / content / popup):** Tasks 3.1–3.4. ✅
- **§3.1 capture+encode (tabCapture → MediaStreamTrackProcessor → WebCodecs avc + Mediabunny `fastStart`, CFR reclock, fallback ladder):** Tasks 3.1, 4.1; reclock spec Task 1.2. ✅
- **§3.2 scroll driver (wall-clock sampling of motion plan; prep/consent/hideFixed/lazy-images/measure/stops):** Tasks 0.4, 1.3, 3.2. ✅
- **§4 reuse (motion.ts + shared verbatim; DOM bodies ported; ffmpeg/Playwright dropped) + §4.1 restructure + delete legacy:** Tasks 0.2–0.5. ✅
- **§5 options/UX + §4.3 preconditions:** Tasks 3.4, 4.3. ✅
- **§6 robustness (fallback, focus-loss, abort):** Tasks 4.1, 4.2. ✅
- **§7 distribution / §10 limitations:** documentation-only (in the spec); no build task. The fixture checklist (4.4) exercises the limitation boundaries (foreground-only, fidelity).
- **§8 testing (pure unit + DOM happy-dom + manual E2E):** Tasks 1.1–1.3, 2.2, 4.4. ✅

**Deferred/optional (noted, not blocking):** make `CaptureOptions.input` optional for the extension surface; chunked-muxer streaming target for multi-minute captures (spec §6 memory note) — add when long captures are needed.
