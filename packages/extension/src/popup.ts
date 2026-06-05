import { browser } from 'wxt/browser';
import { CaptureOptionsSchema, EASINGS, PROFILES, normalizePreset, type ProfileName, type ScrollStop } from '@page-capture/shared';
import { isMessage } from './messages';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const status = $('status') as HTMLDivElement;
const presetInfo = $('presetInfo') as HTMLDivElement;
const profileSel = $('profile') as HTMLSelectElement;
const easingSel = $('easing') as HTMLSelectElement;

let stops: ScrollStop[] | undefined;

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

// Initial values
applyProfile('medium');

profileSel.addEventListener('change', () => {
  if (profileSel.value === 'custom') { ($('adv') as HTMLDetailsElement).open = true; return; }
  applyProfile(profileSel.value as ProfileName);
});
// Editing any timing field flips the profile to "custom"
for (const id of ['pageHold', 'pageScroll', 'velocity', 'holdStart', 'holdEnd', 'easing']) {
  $(id).addEventListener('input', () => { profileSel.value = 'custom'; });
}

$('preset').addEventListener('change', async (ev) => {
  const file = (ev.target as HTMLInputElement).files?.[0];
  if (!file) return;
  try {
    const preset = normalizePreset(JSON.parse(await file.text()));
    stops = preset.stops;
    if (preset.profile) { profileSel.value = preset.profile; applyProfile(preset.profile); }
    presetInfo.textContent =
      `Loaded${preset.name ? ` "${preset.name}"` : ''}: ${stops?.length ?? 0} stops` +
      (preset.profile ? `, ${preset.profile} profile` : '');
  } catch (e) {
    stops = undefined;
    presetInfo.textContent = `Invalid preset: ${(e as Error).message}`;
  }
});

browser.runtime.onMessage.addListener((raw) => {
  if (!isMessage(raw)) return;
  if (raw.type === 'capture:progress') status.textContent = `Encoding ${raw.frame}/${raw.totalFrames}…`;
  if (raw.type === 'capture:done') status.textContent = raw.ok ? `Done (${raw.encoder}).` : `Failed: ${raw.error}`;
});

$('go').addEventListener('click', () => {
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
  status.textContent = 'Starting… keep this tab in front.';
  browser.runtime.sendMessage({ type: 'ui:start', options: parsed.data }).then(
    (res) => { const r = res as { ok?: boolean; error?: string } | undefined; if (!r?.ok) status.textContent = `Error: ${r?.error ?? 'unknown'}`; },
    () => { /* service worker async — ignore */ },
  );
});
