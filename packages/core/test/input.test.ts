import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { InvalidOptionsError } from '../src/errors';
import { detectInput } from '../src/input';

const dir = mkdtempSync(join(tmpdir(), 'pc-input-'));
const pngPath = join(dir, 'shot.png');
writeFileSync(pngPath, Buffer.from([0x89, 0x50, 0x4e, 0x47])); // dummy PNG header bytes

afterAll(() => {
  // best-effort; tmp cleaned by OS
});

describe('detectInput', () => {
  it('detects an https URL', () => {
    expect(detectInput('https://example.com/page')).toEqual({
      kind: 'url',
      url: 'https://example.com/page',
    });
  });

  it('detects an http URL', () => {
    expect(detectInput('http://example.com')).toEqual({
      kind: 'url',
      url: 'http://example.com',
    });
  });

  it('detects a URL with an uppercase scheme', () => {
    expect(detectInput('HTTPS://EXAMPLE.COM').kind).toBe('url');
  });

  it('detects an existing image file by extension', () => {
    expect(detectInput(pngPath)).toEqual({ kind: 'image', path: pngPath });
  });

  it('throws for an image-extension path that does not exist', () => {
    expect(() => detectInput(join(dir, 'missing.png'))).toThrow(
      InvalidOptionsError,
    );
  });

  it('throws for a bare string with no scheme and no image extension', () => {
    expect(() => detectInput('just-some-text')).toThrow(InvalidOptionsError);
  });

  it('throws for a non-http scheme without an image extension', () => {
    expect(() => detectInput('ftp://server/file')).toThrow(InvalidOptionsError);
  });

  it('honors --type url for a scheme-less argument', () => {
    expect(detectInput('example.com', { type: 'url' })).toEqual({
      kind: 'url',
      url: 'example.com',
    });
  });

  it('honors --type image and still requires the file to exist', () => {
    expect(detectInput(pngPath, { type: 'image' })).toEqual({
      kind: 'image',
      path: pngPath,
    });
    expect(() => detectInput(join(dir, 'nope.dat'), { type: 'image' })).toThrow(
      InvalidOptionsError,
    );
  });
});
