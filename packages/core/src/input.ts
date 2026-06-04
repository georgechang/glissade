import { existsSync, statSync } from 'node:fs';
import { extname } from 'node:path';
import type { CaptureInput } from '@page-capture/shared';
import { InvalidOptionsError } from './errors';

/** Extensions we accept as still-image input. */
const IMAGE_EXTENSIONS = new Set([
  '.png',
  '.jpg',
  '.jpeg',
  '.webp',
  '.avif',
  '.tiff',
  '.tif',
  '.bmp',
]);

const URL_SCHEME = /^https?:\/\//i;

export interface DetectOptions {
  /** Force interpretation of the argument, bypassing auto-detection. */
  type?: 'url' | 'image';
}

function assertFileExists(path: string): void {
  if (!existsSync(path) || !statSync(path).isFile()) {
    throw new InvalidOptionsError(
      `image file not found: ${path}`,
    );
  }
}

/**
 * Decide whether a CLI argument is a URL or a local image, and validate it.
 *
 * Auto-detection rules:
 *  - starts with http:// or https:// (case-insensitive) -> URL
 *  - otherwise an existing file with a known image extension -> image
 *  - anything else is ambiguous and rejected (use --type to disambiguate)
 */
export function detectInput(arg: string, opts: DetectOptions = {}): CaptureInput {
  const value = arg.trim();
  if (value.length === 0) {
    throw new InvalidOptionsError('input is empty');
  }

  if (opts.type === 'url') {
    return { kind: 'url', url: value };
  }
  if (opts.type === 'image') {
    assertFileExists(value);
    return { kind: 'image', path: value };
  }

  if (URL_SCHEME.test(value)) {
    return { kind: 'url', url: value };
  }

  if (IMAGE_EXTENSIONS.has(extname(value).toLowerCase())) {
    assertFileExists(value);
    return { kind: 'image', path: value };
  }

  throw new InvalidOptionsError(
    `could not determine input type for "${value}". ` +
      'Provide an http(s):// URL, an image path ' +
      `(${[...IMAGE_EXTENSIONS].join(', ')}), or pass --type url|image.`,
  );
}
