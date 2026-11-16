import { defineConfig } from 'tsup';

export default defineConfig({
  // The inspector is its own entry point, so the core bundle does not carry it (#16).
  entry: { index: 'src/index.ts', inspector: 'src/inspector/index.ts' },
  format: ['esm'],
  target: 'es2022',
  platform: 'browser',
  // tsup's declaration build sets `baseUrl`, which TypeScript 6 flags as deprecated.
  dts: { compilerOptions: { ignoreDeprecations: '6.0' } },
  sourcemap: true,
  clean: true,
  treeshake: true,
});
