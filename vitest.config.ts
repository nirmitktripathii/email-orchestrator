import { defineConfig } from 'vitest/config';
import path from 'path';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    coverage: {
      reporter: ['text', 'json', 'html'],
      include: ['src/**/*.ts'],
      exclude: ['src/**/index.ts'],
    },
  },
  resolve: {
    alias: {
      '@core': path.resolve(__dirname, 'src/orchestrator/core'),
      '@ai': path.resolve(__dirname, 'src/orchestrator/ai'),
      '@providers': path.resolve(__dirname, 'src/orchestrator/providers'),
      '@tools': path.resolve(__dirname, 'src/orchestrator/tools'),
      '@notifications': path.resolve(__dirname, 'src/orchestrator/notifications'),
      '@utils': path.resolve(__dirname, 'src/orchestrator/utils'),
    },
  },
});
