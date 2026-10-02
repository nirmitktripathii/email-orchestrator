import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/orchestrator/index.ts', 'src/orchestrator/http.ts'],
  format: ['esm'],
  dts: true,
  sourcemap: true,
  clean: true,
  target: 'node20',
  splitting: false,
  treeshake: true,
});
