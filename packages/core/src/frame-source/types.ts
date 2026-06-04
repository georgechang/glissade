import type { FramePlan } from '../motion';
import type { PipeInputFormat } from '../encode/ffmpeg';

/**
 * A frame source produces the frames for one capture. The image and URL sources
 * both implement this so the orchestrator and encoder stay source-agnostic.
 */
export interface FrameSourceResult {
  framePlan: FramePlan;
  inputFormat: PipeInputFormat;
  outWidth: number;
  outHeight: number;
  /**
   * Lazily-produced frames, streamed to the encoder one at a time.
   *
   * IMPORTANT: a yielded Buffer may be a transient zero-copy view into a shared
   * decoded buffer (image mode) or the same buffer object reused every iteration
   * (static/letterbox). It is valid ONLY until the next iteration. The encoder
   * writes each frame synchronously, so this is safe; any consumer that RETAINS
   * frames (buffering into an array, deferring) MUST copy them (`Buffer.from(f)`).
   */
  frames: AsyncIterable<Buffer>;
  /** Release any resources held for the duration of framing (e.g. the browser). */
  dispose?: () => Promise<void>;
}
