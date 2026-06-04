// @vitest-environment happy-dom
import { describe, expect, it, vi } from 'vitest';
import {
  dismissConsent,
  hideFixedElements,
  measureStableHeight,
  neutralizeLazyImages,
  resolveStops,
} from '../src/dom-prep';

describe('neutralizeLazyImages', () => {
  it('promotes data-src/data-srcset to src/srcset and sets eager loading', async () => {
    document.body.innerHTML = `<img data-src="a.jpg" data-srcset="a-2x.jpg 2x">`;
    const img = document.querySelector('img')!;
    await neutralizeLazyImages(document);
    expect(img.getAttribute('src')).toBe('a.jpg');
    expect(img.getAttribute('srcset')).toBe('a-2x.jpg 2x');
    expect(img.loading).toBe('eager');
  });
});

describe('hideFixedElements', () => {
  it('hides fixed/sticky elements only', () => {
    document.body.innerHTML =
      `<div id="f" style="position:fixed"></div><div id="s" style="position:sticky"></div><div id="n" style="position:static"></div>`;
    hideFixedElements(document);
    expect((document.getElementById('f') as HTMLElement).style.visibility).toBe('hidden');
    expect((document.getElementById('s') as HTMLElement).style.visibility).toBe('hidden');
    expect((document.getElementById('n') as HTMLElement).style.visibility).toBe('');
  });
});

describe('dismissConsent', () => {
  it('clicks a button matching consent text and reports it', () => {
    document.body.innerHTML = `<button>Accept all</button>`;
    const btn = document.querySelector('button')!;
    const spy = vi.fn();
    btn.addEventListener('click', spy);
    expect(dismissConsent(document)).toBe(true);
    expect(spy).toHaveBeenCalledOnce();
  });
  it('returns false when nothing matches', () => {
    document.body.innerHTML = `<button>Subscribe</button>`;
    expect(dismissConsent(document)).toBe(false);
  });
});

describe('measureStableHeight', () => {
  it('returns the height once it is stable for N reads', async () => {
    const seq = [100, 200, 200, 200, 200];
    let i = 0;
    const h = await measureStableHeight(() => seq[Math.min(i++, seq.length - 1)]!, {
      stableReads: 3, sleep: () => Promise.resolve(),
    });
    expect(h).toBe(200);
  });
  it('caps at maxHeightPx', async () => {
    const h = await measureStableHeight(() => 5000, { maxHeightPx: 1200, sleep: () => Promise.resolve() });
    expect(h).toBe(1200);
  });
});

describe('resolveStops', () => {
  it('resolves offset and percent arithmetically', () => {
    const warn = vi.fn();
    expect(resolveStops([{ offset: 640 }, { percent: 50 }], 1000, warn)).toEqual([{ offset: 640 }, { offset: 500 }]);
    expect(warn).not.toHaveBeenCalled();
  });
  it('skips and warns on an unresolved selector, keeps holdMs', () => {
    const warn = vi.fn();
    const out = resolveStops(
      [{ selector: '#missing' }, { offset: 100, holdMs: 2000 }],
      1000, warn, () => null,
    );
    expect(out).toEqual([{ offset: 100, holdMs: 2000 }]);
    expect(warn).toHaveBeenCalledOnce();
  });
});
