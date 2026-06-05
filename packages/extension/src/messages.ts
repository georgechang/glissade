export type Msg =
  // popup → background
  | { type: 'ui:start'; options: unknown } // options validated by zod in the popup
  // background → content
  | { type: 'drive:start'; fps: number; options: unknown }
  // content → background (plan measured) ; background → offscreen
  | { type: 'capture:start'; streamId: string; fps: number; totalFrames: number; width: number; height: number } // DEPRECATED: replaced by capture:acquire+capture:go (offscreen) / scroll:start (content); removed after migration
  // background → offscreen: acquire the tab stream now (consume the fresh streamId), hold it
  | { type: 'capture:acquire'; streamId: string; fps: number }
  // background → offscreen: encode the held track with these dims/format
  | { type: 'capture:go'; totalFrames: number; width: number; height: number; format: 'mp4' | 'gif'; gifWidth?: number; gifFps?: number }
  // background → content: begin the wall-clock scroll
  | { type: 'scroll:start'; fps: number }
  // content → background
  | { type: 'drive:done' }
  | { type: 'drive:progress'; frame: number; totalFrames: number }
  // offscreen → background (download) → popup (status). The offscreen has no
  // chrome.downloads, so it passes the blob URL + filename for the SW to save.
  | { type: 'capture:done'; ok: true; encoder: string; url: string; filename: string }
  | { type: 'capture:done'; ok: false; error: string }
  | { type: 'capture:progress'; frame: number; totalFrames: number }
  | { type: 'abort' };

const TYPES = new Set<Msg['type']>([
  'ui:start', 'drive:start', 'capture:start', 'capture:acquire', 'capture:go', 'scroll:start', 'drive:done', 'drive:progress',
  'capture:done', 'capture:progress', 'abort',
]);

export function isMessage(x: unknown): x is Msg {
  return typeof x === 'object' && x !== null && TYPES.has((x as { type?: Msg['type'] }).type as Msg['type']);
}
