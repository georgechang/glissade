import { browser } from 'wxt/browser';
import {
  CaptureOptionsSchema, EASINGS, PROFILES, normalizePreset,
  type NormalizedPreset, type ProfileName, type ScrollStop,
} from '@page-capture/shared';
import { isMessage } from './messages';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const status = $('status') as HTMLDivElement;
const presetInfo = $('presetInfo') as HTMLDivElement;
const profileSel = $('profile') as HTMLSelectElement;
const easingSel = $('easing') as HTMLSelectElement;
const go = $('go') as HTMLButtonElement;

let stops: ScrollStop[] | undefined;
let recording = false;

const numVal = (id: string) => Number(($(id) as HTMLInputElement).value);
const setNum = (id: string, v: number) => { ($(id) as HTMLInputElement).value = String(v); };

// Easing options
for (const e of EASINGS) {
  const o = document.createElement('option');
  o.value = e; o.textContent = e;
  if (e === 'easeInOut') o.selected = true;
  easingSel.append(o);
}

function applyProfile(name: ProfileName): void {
  const p = PROFILES[name];
  setNum('pageHold', p.pageHoldMs);
  setNum('pageScroll', p.pageScrollMs);
  setNum('velocity', p.velocityVhPerSec);
  setNum('holdStart', p.holdStartMs);
  setNum('holdEnd', p.holdEndMs);
}

applyProfile('medium');

profileSel.addEventListener('change', () => {
  if (profileSel.value === 'custom') { ($('adv') as HTMLDetailsElement).open = true; return; }
  applyProfile(profileSel.value as ProfileName);
});
// Editing any timing field flips the profile to "custom"
for (const id of ['pageHold', 'pageScroll', 'velocity', 'holdStart', 'holdEnd', 'easing']) {
  $(id).addEventListener('input', () => { profileSel.value = 'custom'; });
}

// --- Per-page preset cache (chrome.storage.local, keyed by origin+pathname) ---
async function currentPageKey(): Promise<string | null> {
  try {
    const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
    if (!tab?.url) return null;
    const u = new URL(tab.url);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    return `preset:${u.origin}${u.pathname}`;
  } catch {
    return null;
  }
}

function applyPreset(preset: NormalizedPreset, note: string): void {
  stops = preset.stops;
  if (preset.profile) { profileSel.value = preset.profile; applyProfile(preset.profile); }
  presetInfo.textContent =
    `${note}${preset.name ? ` "${preset.name}"` : ''}: ${stops?.length ?? 0} stops` +
    (preset.profile ? `, ${preset.profile} profile` : '');
}

async function savePresetForPage(preset: NormalizedPreset): Promise<void> {
  const key = await currentPageKey();
  if (key) await browser.storage.local.set({ [key]: preset });
}

// On open: reuse a saved preset for this page, if any.
void (async () => {
  const key = await currentPageKey();
  if (!key) return;
  const got = await browser.storage.local.get(key);
  const cached = got[key] as NormalizedPreset | undefined;
  if (cached && (cached.stops?.length || cached.profile)) applyPreset(cached, 'Reusing saved preset');
})();

$('preset').addEventListener('change', async (ev) => {
  const file = (ev.target as HTMLInputElement).files?.[0];
  if (!file) return;
  try {
    const preset = normalizePreset(JSON.parse(await file.text()));
    applyPreset(preset, 'Loaded');
    void savePresetForPage(preset); // cache it for next time on this page
  } catch (e) {
    stops = undefined;
    presetInfo.textContent = `Invalid preset: ${(e as Error).message}`;
  }
});

function setRecording(on: boolean): void {
  recording = on;
  go.textContent = on ? 'Cancel recording' : 'Record this tab';
  go.classList.toggle('danger', on);
}

browser.runtime.onMessage.addListener((raw) => {
  if (!isMessage(raw)) return;
  if (raw.type === 'capture:progress') status.textContent = `Encoding ${raw.frame}/${raw.totalFrames}…`;
  if (raw.type === 'capture:done') {
    status.textContent = raw.ok ? `Done (${raw.encoder}).` : `Failed: ${raw.error}`;
    setRecording(false);
  }
});

go.addEventListener('click', () => {
  if (recording) {
    browser.runtime.sendMessage({ type: 'abort' }).catch(() => {});
    status.textContent = 'Cancelling…';
    return;
  }
  const maxH = numVal('maxHeight');
  const optionsInput: Record<string, unknown> = {
    input: { kind: 'url', url: 'https://placeholder.local/' }, // ignored by the extension; satisfies the schema
    fps: Number(($('fps') as HTMLSelectElement).value),
    scrollStyle: ($('style') as HTMLSelectElement).value,
    roundTrip: ($('roundTrip') as HTMLInputElement).checked,
    scrollSpeed: numVal('velocity'),
    easing: easingSel.value,
    pageHoldMs: numVal('pageHold'),
    pageScrollMs: numVal('pageScroll'),
    holds: { startMs: numVal('holdStart'), endMs: numVal('holdEnd') },
    hideFixed: ($('hideFixed') as HTMLInputElement).checked,
    reloadBeforeCapture: ($('reload') as HTMLInputElement).checked,
    ...(stops && stops.length ? { stops } : {}),
    ...(maxH > 0 ? { maxHeightPx: maxH } : {}),
  };
  const parsed = CaptureOptionsSchema.safeParse(optionsInput);
  if (!parsed.success) { status.textContent = parsed.error.issues[0]?.message ?? 'invalid options'; return; }
  setRecording(true);
  status.textContent = 'Starting… keep this tab in front.';
  browser.runtime.sendMessage({ type: 'ui:start', options: parsed.data }).then(
    (res) => {
      const r = res as { ok?: boolean; error?: string } | undefined;
      if (!r?.ok) { status.textContent = `Error: ${r?.error ?? 'unknown'}`; setRecording(false); }
    },
    () => { /* service worker async — ignore */ },
  );
});
