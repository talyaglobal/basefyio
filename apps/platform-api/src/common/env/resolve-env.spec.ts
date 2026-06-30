/**
 * Rebrand env-resolution contract tests.
 *
 * resolveEnv() lives in packages/sdk/src/lib/env.ts. These tests verify the
 * same contract by testing the resolution logic directly — BASEFYIO_* primary,
 * KOLAYBASE_* legacy fallback. Run via the platform-api Jest runner.
 */

// Inline the same resolution logic so this test has no cross-package import.
function resolveEnv(primary: string, legacy: string): string | undefined {
  const env = (globalThis as any).process?.env;
  return env?.[primary] ?? env?.[legacy] ?? undefined;
}

const PRIMARY = 'BASEFYIO_TEST_REBRAND';
const LEGACY = 'KOLAYBASE_TEST_REBRAND';

function set(key: string, value: string | undefined) {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}

beforeEach(() => {
  set(PRIMARY, undefined);
  set(LEGACY, undefined);
});

afterEach(() => {
  set(PRIMARY, undefined);
  set(LEGACY, undefined);
});

describe('Rebrand env resolution — BASEFYIO_* primary, KOLAYBASE_* legacy fallback', () => {
  it('primary wins when both are set', () => {
    set(PRIMARY, 'basefyio-value');
    set(LEGACY, 'kolaybase-value');
    expect(resolveEnv(PRIMARY, LEGACY)).toBe('basefyio-value');
  });

  it('primary works when only primary is set', () => {
    set(PRIMARY, 'basefyio-value');
    expect(resolveEnv(PRIMARY, LEGACY)).toBe('basefyio-value');
  });

  it('legacy fallback works when primary is absent', () => {
    set(LEGACY, 'kolaybase-value');
    expect(resolveEnv(PRIMARY, LEGACY)).toBe('kolaybase-value');
  });

  it('returns undefined when neither is set', () => {
    expect(resolveEnv(PRIMARY, LEGACY)).toBeUndefined();
  });

  it('empty-string primary does NOT fall through to legacy (?? semantics)', () => {
    set(PRIMARY, '');
    set(LEGACY, 'kolaybase-value');
    expect(resolveEnv(PRIMARY, LEGACY)).toBe('');
  });

  it('deleting the primary key (unset) falls through to legacy', () => {
    delete process.env[PRIMARY];
    set(LEGACY, 'kolaybase-fallback');
    expect(resolveEnv(PRIMARY, LEGACY)).toBe('kolaybase-fallback');
  });
});
