import { defineProject } from 'vitest/config';

export default defineProject({
  esbuild: { jsx: 'automatic', jsxImportSource: 'hono/jsx' },
  test: {
    name: 'library',
    environment: 'node',
    include: ['test/**/*.test.ts', 'test/**/*.test.tsx'],
    testTimeout: 30_000,
  },
});
