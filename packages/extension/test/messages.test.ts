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
