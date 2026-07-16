import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
    globals: false,
    testTimeout: 10000
  },
  resolve: {
    // Source code uses .js extensions in imports (Node ESM standard).
    // Vitest resolves them to .ts files.
    extensions: ['.ts', '.js', '.mjs', '.json']
  }
});
