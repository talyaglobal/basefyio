import { defineConfig } from 'tsup';
import { writeFileSync, readFileSync } from 'fs';
import { resolve } from 'path';

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  dts: true,
  clean: true,
  shims: true,
  minify: false,
  sourcemap: true,
  splitting: true,
  // Don't use banner — with splitting it injects the shebang into every chunk.
  // Instead, prepend it to the entry point after the build finishes.
  onSuccess: async () => {
    const entry = resolve('dist', 'index.js');
    const content = readFileSync(entry, 'utf-8');
    if (!content.startsWith('#!')) {
      writeFileSync(entry, `#!/usr/bin/env node\n${content}`);
    }
  },
});
