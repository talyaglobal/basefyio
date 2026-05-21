import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts', 'src/cli.ts'],
  format: ['esm', 'cjs'],
  dts: { entry: 'src/index.ts' },
  splitting: false,
  sourcemap: true,
  clean: true,
  minify: false,
});
