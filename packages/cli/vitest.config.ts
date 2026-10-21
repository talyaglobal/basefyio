// A plain object rather than `defineConfig` from 'vitest/config': the shape is
// the same, and the file then has no import to resolve, so the suite can also
// be run with a vitest binary that lives outside this package.
export default {
  test: {
    include: ['src/**/*.test.ts'],
    environment: 'node',
  },
};
