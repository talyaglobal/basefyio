import {
  sanitizeColumnName,
  dedupeColumnNames,
  inferColumnType,
  castValue,
} from './type-inferrer';

describe('type-inferrer', () => {
  describe('sanitizeColumnName', () => {
    it('produces a Postgres-safe identifier', () => {
      expect(sanitizeColumnName('First Name', 0)).toMatch(/^[a-z_][a-z0-9_]*$/i);
      expect(sanitizeColumnName('e-mail!', 0)).toMatch(/^[a-z_][a-z0-9_]*$/i);
    });
    it('always returns a non-empty name, even for blank headers', () => {
      expect(sanitizeColumnName('', 3).length).toBeGreaterThan(0);
    });
  });

  describe('dedupeColumnNames', () => {
    it('makes colliding names unique', () => {
      const out = dedupeColumnNames(['a', 'a', 'a']);
      expect(new Set(out).size).toBe(3);
      expect(out[0]).toBe('a');
    });
  });

  describe('inferColumnType', () => {
    it('detects integer, numeric, boolean, and text', () => {
      expect(inferColumnType(['1', '2', '3']).type).toBe('integer');
      expect(inferColumnType(['1.5', '2.5']).type).toBe('numeric');
      expect(inferColumnType(['true', 'false']).type).toBe('boolean');
      expect(inferColumnType(['hello', 'world']).type).toBe('text');
    });
    it('flags nullable when a null/blank value is present', () => {
      expect(inferColumnType(['1', null, '2']).nullable).toBe(true);
      expect(inferColumnType(['1', '2']).nullable).toBe(false);
    });
    it('falls back to text for an all-empty column', () => {
      expect(inferColumnType([null, '', undefined]).type).toBe('text');
    });
  });

  describe('castValue', () => {
    it('casts a valid integer to a number', () => {
      const r = castValue('42', 'integer', false);
      expect(r.ok).toBe(true);
      if (r.ok) expect(typeof r.value).toBe('number');
    });
    it('rejects a non-numeric value for an integer column', () => {
      expect(castValue('abc', 'integer', false).ok).toBe(false);
    });
    it('accepts null when nullable, rejects it when not', () => {
      expect(castValue(null, 'text', true)).toEqual({ ok: true, value: null });
      expect(castValue(null, 'text', false).ok).toBe(false);
    });
  });
});
