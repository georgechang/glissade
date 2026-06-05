import { browser } from 'wxt/browser';
import {
  CaptureOptionsSchema, EASINGS, PROFILES, defaultEasingForStyle, normalizePreset,
  type NormalizedPreset, type ProfileName, type ScrollStop, type ScrollStyle,
} from '@page-capture/shared';
import { isMessage } from './messages';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const status = $('status') as HTMLDivElement;
const presetInfo = $('presetInfo') as HTMLDivElement;
const profileSel = $('profile') as HTMLSelectElement;
const easingSel = $('easing') as HTMLSelectElement;
const go = $('go') as HTMLButtonElement;
const loadedView = $('loadedView') as HTMLDetailsElement;
const loadedJson = $('loadedJson') as HTMLPreElement;
const pppHint = $('pppHint') as HTMLSpanElement;
const clearPreset = $('clearPreset') as HTMLButtonElement;

let stops: ScrollStop[] | undefined;
let recording = false;
let cancelTimer: ReturnType<typeof setTimeout> | undefined;
let easingUserSet = false; // once the user picks an easing, stop auto-defaulting it per style

const numVal = (id: string) => Number(($(id) as HTMLInputElement).value);
const setNum = (id: string, v: number) => { ($(id) as HTMLInputElement).value = String(v); };

// Easing options
const EASING_LABELS: Record<string, string> = {
  linear: 'Linear (steady)',
  easeIn: 'Ease in',
  easeOut: 'Ease out',
  easeInOut: 'Ease in-out',
  easeInOutSine: 'Smooth (sine)',
  smoothstep: 'Smoothstep',
};
for (const e of EASINGS) {
  const o = document.createElement('option');
  o.value = e; o.textContent = EASING_LABELS[e] ?? e;
  easingSel.append(o);
}
// Initial selection is set by syncEasingDefault() once the style control exists.

function applyProfile(name: ProfileName): void {
  const p = PROFILES[name];
  setNum('pageHold', p.pageHoldMs);
  setNum('pageScroll', p.pageScrollMs);
  setNum('velocity', p.velocityVhPerSec);
  setNum('holdEnd', p.holdEndMs);
}

applyProfile('medium');

profileSel.addEventListener('change', () => {
  if (profileSel.value === 'custom') { ($('adv') as HTMLDetailsElement).open = true; return; }
  applyProfile(profileSel.value as ProfileName);
});
// Editing any timing field flips the speed profile to "custom"
for (const id of ['pageHold', 'pageScroll', 'velocity', 'holdEnd']) {
  $(id).addEventListener('input', () => { profileSel.value = 'custom'; });
}
// Easing is orthogonal to the speed profile and defaults per style (see
// syncEasingDefault); a manual pick sticks across style changes.
easingSel.addEventListener('change', () => { easingUserSet = true; });

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

const pointWord = (n: number): string => `${n} point${n === 1 ? '' : 's'}`;

function applyPreset(preset: NormalizedPreset, note: string): void {
  stops = preset.stops;
  if (preset.profile) { profileSel.value = preset.profile; applyProfile(preset.profile); }
  const n = stops?.length ?? 0;
  presetInfo.textContent =
    note + (preset.name ? ` — "${preset.name}"` : '') +
    (preset.profile ? `, ${preset.profile} profile` : ''); // count shown by the badge
  pppHint.textContent = n > 0 ? pointWord(n) : 'Optional';
  pppHint.classList.toggle('loaded', n > 0);
  clearPreset.hidden = n === 0;
  if (n > 0 && stops) {
    // one point per line (compact, matches the example format) rather than fully-expanded JSON
    loadedJson.textContent = `[\n${stops.map((s) => `  ${JSON.stringify(s)}`).join(',\n')}\n]`;
    loadedView.hidden = false;
  } else {
    loadedView.hidden = true;
  }
}

async function clearLoadedPoints(): Promise<void> {
  stops = undefined;
  presetInfo.textContent = '';
  pppHint.textContent = 'Optional';
  pppHint.classList.remove('loaded');
  clearPreset.hidden = true;
  loadedView.hidden = true;
  loadedView.open = false;
  ($('preset') as HTMLInputElement).value = ''; // allow re-selecting the same file
  const key = await currentPageKey();
  if (key) await browser.storage.local.remove(key); // don't auto-restore it next time
}
clearPreset.addEventListener('click', () => { void clearLoadedPoints(); });

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
  if (cached && (cached.stops?.length || cached.profile)) applyPreset(cached, 'Saved for this page');
})();

// Reload note visibility
const reloadNote = $('reloadNote');
const reloadCb = $('reload') as HTMLInputElement;
const syncReloadNote = () => { reloadNote.hidden = !reloadCb.checked; };
reloadCb.addEventListener('change', syncReloadNote);
syncReloadNote();

// Style-aware Advanced knobs
const styleSel = $('style') as HTMLSelectElement;
const syncStyleKnobs = () => {
  const reading = styleSel.value === 'reading';
  document.querySelectorAll<HTMLElement>('.reading-only').forEach((el) => { el.style.display = reading ? '' : 'none'; });
  document.querySelectorAll<HTMLElement>('.continuous-only').forEach((el) => { el.style.display = reading ? 'none' : ''; });
};
// Continuous eases across the whole page (ease-in-out rushes the middle), so it
// defaults to a smooth, steady linear glide; reading keeps ease-in-out per
// screen-step. Skipped once the user has chosen an easing themselves.
const syncEasingDefault = () => {
  if (!easingUserSet) easingSel.value = defaultEasingForStyle(styleSel.value as ScrollStyle);
};
styleSel.addEventListener('change', () => { syncStyleKnobs(); syncEasingDefault(); });
syncStyleKnobs();
syncEasingDefault();

// On open: populate the target chip and guard Record button for uncapturable pages.
void (async () => {
  try {
    const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
    const url = tab?.url ?? '';
    let host = '';
    try { host = new URL(url).host; } catch { /* */ }
    const supported = /^https?:$/.test((() => { try { return new URL(url).protocol; } catch { return ''; } })())
      && !/^https:\/\/chrome\.google\.com\/webstore/.test(url) && !/^https:\/\/chromewebstore\.google\.com/.test(url);
    if (host) {
      ($('tabHost') as HTMLSpanElement).textContent = host;
      if (tab?.favIconUrl) ($('tabIcon') as HTMLImageElement).src = tab.favIconUrl; else ($('tabIcon') as HTMLImageElement).hidden = true;
      ($('target') as HTMLDivElement).hidden = false;
    }
    if (!supported) {
      go.disabled = true;
      go.style.opacity = '0.5';
      go.style.cursor = 'not-allowed';
      status.textContent = 'Page Capture only records normal web pages (http/https). This page can\'t be recorded.';
    }
  } catch { /* leave enabled */ }
})();

$('preset').addEventListener('change', async (ev) => {
  const file = (ev.target as HTMLInputElement).files?.[0];
  if (!file) return;
  if (file.size > 256 * 1024) {
    presetInfo.textContent = 'That file is too large (max 256 KB).';
    return;
  }
  const reset = () => {
    stops = undefined;
    loadedView.hidden = true;
    clearPreset.hidden = true;
    pppHint.textContent = 'Optional';
    pppHint.classList.remove('loaded');
  };
  let parsed: unknown;
  try {
    parsed = JSON.parse(await file.text());
  } catch {
    reset();
    presetInfo.textContent = "That file isn't valid JSON.";
    return;
  }
  try {
    const preset = normalizePreset(parsed);
    applyPreset(preset, 'Loaded from file');
    void savePresetForPage(preset); // cache it for next time on this page
    ($('ppp') as HTMLDetailsElement).open = true; // surface what was just loaded
  } catch {
    reset();
    presetInfo.textContent = 'Not a valid pause-points file — each item needs a selector, percent, or offset.';
  }
});

function setRecording(on: boolean): void {
  recording = on;
  go.textContent = on ? 'Cancel recording' : 'Record this tab';
  go.classList.toggle('danger', on);
}

browser.runtime.onMessage.addListener((raw) => {
  if (!isMessage(raw)) return;
  if (raw.type === 'capture:phase') status.textContent = raw.phase;
  else if (raw.type === 'drive:progress') status.textContent = `Recording ${raw.frame}/${raw.totalFrames}…`;
  else if (raw.type === 'capture:done') {
    status.textContent = raw.ok ? `Saved as ${raw.encoder.includes('webm') ? 'WebM' : 'MP4'}.` : `Failed: ${raw.error}`;
    setRecording(false);
    if (cancelTimer !== undefined) { clearTimeout(cancelTimer); cancelTimer = undefined; }
  }
});

go.addEventListener('click', () => {
  if (recording) {
    browser.runtime.sendMessage({ type: 'abort', reason: 'Recording cancelled.' }).catch(() => {});
    status.textContent = 'Cancelling…';
    cancelTimer = setTimeout(() => { setRecording(false); status.textContent = 'Recording cancelled.'; browser.action.setBadgeText({ text: '' }).catch(() => {}); }, 4000);
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
    holds: { endMs: numVal('holdEnd') }, // top dwell uses pageHoldMs (see content.ts); startMs defaults
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

// Info tooltips: one shared box, positioned next to the hovered icon and clamped to the popup.
const tip = document.createElement('div');
tip.id = 'tip';
document.body.append(tip);
let tipActiveEl: HTMLElement | null = null;
function showTip(el: HTMLElement): void {
  const text = el.dataset.tip;
  if (!text) return;
  tip.textContent = text;
  tip.style.display = 'block';
  tipActiveEl = el;
  const r = el.getBoundingClientRect();
  const vw = document.documentElement.clientWidth;
  const vh = document.documentElement.clientHeight;
  let left = r.left + r.width / 2 - tip.offsetWidth / 2;
  left = Math.max(6, Math.min(left, vw - tip.offsetWidth - 6));
  let top = r.bottom + 6;
  if (top + tip.offsetHeight > vh - 4) top = r.top - tip.offsetHeight - 6; // flip above if it would overflow
  tip.style.left = `${Math.round(left)}px`;
  tip.style.top = `${Math.round(top)}px`;
}
const hideTip = (): void => { tip.style.display = 'none'; tipActiveEl = null; };
for (const el of document.querySelectorAll<HTMLElement>('[data-tip]')) {
  el.setAttribute('aria-label', el.dataset.tip ?? 'More info');
  el.addEventListener('mouseenter', () => showTip(el));
  el.addEventListener('mouseleave', hideTip);
  el.addEventListener('focus', () => showTip(el));
  el.addEventListener('blur', hideTip);
  el.addEventListener('click', () => {
    if (tipActiveEl === el) { hideTip(); } else { showTip(el); }
  });
}
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') hideTip(); });
