import { browser } from 'wxt/browser';
import { CaptureOptionsSchema } from '@page-capture/shared';
import { isMessage } from './messages';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const status = $('status') as HTMLDivElement;

browser.runtime.onMessage.addListener((raw) => {
  if (!isMessage(raw)) return;
  if (raw.type === 'capture:progress') status.textContent = `Encoding ${raw.frame}/${raw.totalFrames}…`;
  if (raw.type === 'capture:done') status.textContent = raw.ok ? `Done (${raw.encoder}).` : `Failed: ${raw.error}`;
});

$('go').addEventListener('click', async () => {
  const parsed = CaptureOptionsSchema.safeParse({
    input: { kind: 'url', url: 'https://placeholder.local/' }, // input is ignored by the extension; satisfies the schema
    fps: Number(($('fps') as HTMLSelectElement).value),
    scrollStyle: ($('style') as HTMLSelectElement).value,
    roundTrip: ($('roundTrip') as HTMLInputElement).checked,
  });
  if (!parsed.success) { status.textContent = parsed.error.issues[0]?.message ?? 'invalid options'; return; }
  status.textContent = 'Starting… keep this tab in front.';
  const res = (await browser.runtime.sendMessage({ type: 'ui:start', options: parsed.data })) as
    { ok: boolean; error?: string } | undefined;
  if (!res?.ok) status.textContent = `Error: ${res?.error ?? 'unknown'}`;
});
