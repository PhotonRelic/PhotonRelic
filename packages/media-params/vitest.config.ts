import { defineProject } from 'vitest/config';

export default defineProject({
  test: {
    name: 'media-params',
    environment: 'node',
    include: ['test/**/*.test.ts'],
  },
});
