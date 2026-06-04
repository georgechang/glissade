/**
 * Typed errors. The core NEVER calls process.exit or writes to stdout/stderr —
 * it throws these so each host (CLI, worker, web API) can map them to exit
 * codes, HTTP statuses, or job-failure reasons as it sees fit.
 */

export class PageCaptureError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

/** Invalid/contradictory input or options (bad URL, missing file, etc.). */
export class InvalidOptionsError extends PageCaptureError {}

/** The page failed to load or navigate. */
export class NavigationError extends PageCaptureError {}

/** ffmpeg failed to encode the frames. */
export class EncodeError extends PageCaptureError {}

/** An operation exceeded its time budget. */
export class TimeoutError extends PageCaptureError {}

/** The capture was aborted via an AbortSignal. */
export class CaptureAbortedError extends PageCaptureError {
  constructor(message = 'capture aborted') {
    super(message);
  }
}
