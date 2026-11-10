import {
  sanitizeColumnName,
  dedupeColumnNames,
  inferColumnType,
  castValue,
  detectValueFormat,
  normalizeNumber,
  parseDateValue,
  parseTimestampValue,
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

describe('type-inferrer — Turkish data', () => {
  describe('sanitizeColumnName', () => {
    it('transliterates Turkish letters instead of dropping them', () => {
      expect(sanitizeColumnName('şehir', 0)).toBe('sehir');
      expect(sanitizeColumnName('açıklama', 0)).toBe('aciklama');
      expect(sanitizeColumnName('İl Adı', 0)).toBe('il_adi');
      expect(sanitizeColumnName('Ürün Ğrubu', 0)).toBe('urun_grubu');
    });
  });

  describe('detectValueFormat', () => {
    it('recognizes decimal commas and day-first dates', () => {
      expect(detectValueFormat([['12,5', '31.12.1999'], ['1.234,56', '01.10.2026']])).toEqual({
        decimalSeparator: ',',
        dateOrder: 'DMY',
      });
    });
    it('recognizes decimal dots and month-first dates', () => {
      expect(detectValueFormat([['12.5', '12/31/1999'], ['1,234.56', '01/02/2026']])).toEqual({
        decimalSeparator: '.',
        dateOrder: 'MDY',
      });
    });
    it('does not let ambiguous "1.234" decide the separator', () => {
      expect(detectValueFormat([['1.234'], ['5.678']]).decimalSeparator).toBe('.');
    });
  });

  describe('numbers', () => {
    it('reads Turkish-formatted numbers with the comma separator', () => {
      expect(normalizeNumber('12,5', ',')).toBe('12.5');
      expect(normalizeNumber('1.234,56', ',')).toBe('1234.56');
      expect(normalizeNumber('-1.234.567', ',')).toBe('-1234567');
      expect(normalizeNumber('1 234,5', ',')).toBe('1234.5');
      expect(normalizeNumber('12.5', ',')).toBeNull();
      expect(normalizeNumber('1,234.56', '.')).toBe('1234.56');
    });
    it('infers and casts numeric/integer columns written the Turkish way', () => {
      const fmt = { decimalSeparator: ',' as const, dateOrder: 'DMY' as const };
      expect(inferColumnType(['12,5', '1.234,56'], fmt).type).toBe('numeric');
      expect(inferColumnType(['1.234', '12'], fmt).type).toBe('integer');
      expect(castValue('1.234,56', 'numeric', true, fmt)).toEqual({ ok: true, value: '1234.56' });
      expect(castValue('1.234', 'integer', true, fmt)).toEqual({ ok: true, value: 1234 });
    });
    it('reads native JSON numbers with a dot even in a comma file', () => {
      const fmt = { decimalSeparator: ',' as const, dateOrder: 'DMY' as const };
      expect(castValue(12.5, 'numeric', true, fmt)).toEqual({ ok: true, value: '12.5' });
      expect(inferColumnType([12.5, 3], fmt).type).toBe('numeric');
    });
  });

  describe('dates and timestamps', () => {
    it('reads dd.mm.yyyy and dd.mm.yyyy hh:mm', () => {
      expect(parseDateValue('31.12.1999', 'DMY')).toBe('1999-12-31');
      expect(parseTimestampValue('01.10.2026 10:00', 'DMY')).toBe('2026-10-01 10:00:00');
      expect(castValue('31.12.1999', 'date', true)).toEqual({ ok: true, value: '1999-12-31' });
    });
    it('reads mm/dd/yyyy when the order says month first', () => {
      expect(parseDateValue('12/31/1999', 'MDY')).toBe('1999-12-31');
      expect(parseDateValue('12/31/1999', 'DMY')).toBeNull();
    });
    it('rejects impossible dates', () => {
      expect(parseDateValue('31.02.2026', 'DMY')).toBeNull();
      expect(parseDateValue('2026-02-30', 'DMY')).toBeNull();
    });
    it('accepts a "+03" zone suffix', () => {
      expect(parseTimestampValue('2026-10-01 10:00:00+03', 'DMY')).toBe('2026-10-01 10:00:00+03');
      expect(parseTimestampValue('2026-10-01T10:00Z', 'DMY')).toBe('2026-10-01 10:00:00+00');
      expect(inferColumnType(['2026-10-01 10:00+03']).type).toBe('timestamptz');
    });
  });

  describe('booleans', () => {
    it('accepts evet/hayır in any case', () => {
      expect(inferColumnType(['evet', 'hayır', 'EVET', 'HAYIR']).type).toBe('boolean');
      expect(castValue('Hayır', 'boolean', true)).toEqual({ ok: true, value: false });
      expect(castValue('Doğru', 'boolean', true)).toEqual({ ok: true, value: true });
    });
  });

  describe('empty cells and spaces in text', () => {
    it('defaults to NULL for empty cells and trims text, as before', () => {
      expect(castValue('', 'text', true)).toEqual({ ok: true, value: null });
      expect(castValue('  spaced  ', 'text', true)).toEqual({ ok: true, value: 'spaced' });
    });
    it('can keep empty strings and surrounding spaces when asked', () => {
      const keep = { emptyAsNull: false, trimText: false };
      expect(castValue('', 'text', false, keep)).toEqual({ ok: true, value: '' });
      expect(castValue('  spaced  ', 'text', true, keep)).toEqual({ ok: true, value: '  spaced  ' });
      // NULL stays NULL, and other types still treat an empty cell as NULL.
      expect(castValue('NULL', 'text', true, keep)).toEqual({ ok: true, value: null });
      expect(castValue('', 'integer', true, keep)).toEqual({ ok: true, value: null });
    });
  });

  it('sends jsonb as validated text so arrays are not turned into Postgres arrays', () => {
    expect(castValue('[1,2]', 'jsonb', true)).toEqual({ ok: true, value: '[1,2]' });
    expect(castValue('{bad', 'jsonb', true).ok).toBe(false);
  });
});
