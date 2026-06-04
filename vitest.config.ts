import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

// Resolve internal workspace packages to their TypeScript source so tests run
// against source without a build step (fast TDD iteration).
const r = (p: string) => fileURLToPath(new URL(p, import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      '@page-capture/shared': r('./packages/shared/src/index.ts'),
      '@page-capture/scroll-engine': r('./packages/scroll-engine/src/index.ts'),
      '@page-capture/extension': r('./packages/extension/src/index.ts'),
    },
  },
  test: {
    environment: 'node',
    include: ['packages/*/test/**/*.test.ts'],
    // Browser/encoder integration tests need generous time.
    testTimeout: 120_000,
    hookTimeout: 120_000,
  },
});
