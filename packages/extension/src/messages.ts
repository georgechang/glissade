export type Msg =
  // popup → background
  | { type: 'ui:start'; options: unknown } // options validated by zod in the popup
  // background → content
  | { type: 'drive:start'; fps: number; options: unknown }
  // background → offscreen: acquire the tab stream now (consume the fresh streamId), hold it.
  // maxWidth/maxHeight cap the captured resolution so the encoder can keep up with fps.
  | { type: 'capture:acquire'; streamId: string; fps: number; maxWidth?: number; maxHeight?: number }
  // background → offscreen: start encoding the held track (dimensions from first frame)
  | { type: 'capture:go' }
  // background → offscreen: tighten the runaway frame cap
  | { type: 'capture:bound'; maxFrames: number }
  // background → content: begin the wall-clock scroll
  | { type: 'scroll:start'; fps: number }
  // content → background: new page's first paint (Chrome Paint Holding has ended)
  | { type: 'page:firstPaint' }
  // content → background
  | { type: 'drive:done' }
  | { type: 'drive:progress'; frame: number; totalFrames: number }
  // offscreen → background (download) → popup (status). The offscreen has no
  // chrome.downloads, so it passes the blob URL + filename for the SW to save.
  | { type: 'capture:done'; ok: true; encoder: string; url: string; filename: string }
  | { type: 'capture:done'; ok: false; error: string }
  // background → popup: human-readable pipeline phase (reloading / waiting / recording / encoding / saving)
  | { type: 'capture:phase'; phase: string }
  // abort can carry a reason so the outcome reads meaningfully (cancel vs lost-focus)
  | { type: 'abort'; reason?: string };

const TYPES = new Set<Msg['type']>([
  'ui:start', 'drive:start', 'capture:acquire', 'capture:go', 'capture:bound', 'scroll:start',
  'page:firstPaint', 'drive:done', 'drive:progress',
  'capture:done', 'capture:phase', 'abort',
]);

export function isMessage(x: unknown): x is Msg {
  return typeof x === 'object' && x !== null && TYPES.has((x as { type?: Msg['type'] }).type as Msg['type']);
}
