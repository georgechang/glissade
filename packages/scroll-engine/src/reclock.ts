/** Frame index to display after `elapsedMs` of a capture at `fps`, clamped to the plan length. */
export function frameAtElapsed(elapsedMs: number, fps: number, totalFrames: number): number {
  const idx = Math.round((elapsedMs * fps) / 1000);
  return Math.min(totalFrames - 1, Math.max(0, idx));
}

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
