import { isTransientSourceError, readsAsText, sourceSelectList, withTransientRetry } from './supabase-copy.util';

describe('sourceSelectList', () => {
  it('reads temporal and binary columns as text so no driver object truncates them', () => {
    const list = sourceSelectList([
      { column_name: 'id', data_type: 'uuid' },
      { column_name: 'created_at', data_type: 'timestamp with time zone' },
      { column_name: 'day', data_type: 'date' },
      { column_name: 'blob', data_type: 'bytea' },
      { column_name: 'name', data_type: 'text' },
    ]);
    expect(list).toBe('"id", "created_at"::text AS "created_at", "day"::text AS "day", "blob"::text AS "blob", "name"');
  });

  it('recognises both spellings of a type', () => {
    expect(readsAsText('timestamptz')).toBe(true);
    expect(readsAsText('TIMESTAMP WITHOUT TIME ZONE')).toBe(true);
    expect(readsAsText('interval')).toBe(true);
    expect(readsAsText('integer')).toBe(false);
    expect(readsAsText('jsonb')).toBe(false);
    expect(readsAsText(undefined)).toBe(false);
  });

  it('strips anything that is not an identifier character, like the rest of the copy', () => {
    expect(sourceSelectList([{ column_name: 'a"; drop table x; --', data_type: 'text' }])).toBe('"adroptablex"');
  });
});

describe('isTransientSourceError', () => {
  it.each(['53300', '53400', '57P03', '08006'])('treats SQLSTATE %s as transient', (code) => {
    expect(isTransientSourceError({ code })).toBe(true);
  });

  it('recognises the connection-slot messages the import hit', () => {
    expect(
      isTransientSourceError({ message: 'remaining connection slots are reserved for roles with the SUPERUSER attribute' }),
    ).toBe(true);
    expect(isTransientSourceError({ message: 'sorry, too many clients already' })).toBe(true);
    expect(isTransientSourceError({ message: 'read ECONNRESET' })).toBe(true);
  });

  it('does not retry a real answer', () => {
    expect(isTransientSourceError({ code: '42P01', message: 'relation "x" does not exist' })).toBe(false);
    expect(isTransientSourceError({ code: '42501', message: 'permission denied for table x' })).toBe(false);
    expect(isTransientSourceError(null)).toBe(false);
  });
});

describe('withTransientRetry', () => {
  const slots = () => Object.assign(new Error('remaining connection slots are reserved'), { code: '53300' });
  const noSleep = async () => undefined;

  it('retries a transient failure and returns the eventual result', async () => {
    let calls = 0;
    const out = await withTransientRetry(
      async () => {
        calls++;
        if (calls < 3) throw slots();
        return 'rows';
      },
      { sleep: noSleep },
    );
    expect(out).toBe('rows');
    expect(calls).toBe(3);
  });

  it('doubles the pause each time', async () => {
    const delays: number[] = [];
    let calls = 0;
    await withTransientRetry(
      async () => {
        if (++calls < 4) throw slots();
      },
      { baseMs: 100, sleep: async (ms) => void delays.push(ms) },
    );
    expect(delays).toEqual([100, 200, 400]);
  });

  it('gives up after the retries and throws the last error', async () => {
    let calls = 0;
    await expect(
      withTransientRetry(
        async () => {
          calls++;
          throw slots();
        },
        { retries: 2, sleep: noSleep },
      ),
    ).rejects.toThrow(/connection slots/);
    expect(calls).toBe(3);
  });

  it('does not retry an error that is not transient', async () => {
    let calls = 0;
    await expect(
      withTransientRetry(
        async () => {
          calls++;
          throw Object.assign(new Error('permission denied'), { code: '42501' });
        },
        { sleep: noSleep },
      ),
    ).rejects.toThrow(/permission denied/);
    expect(calls).toBe(1);
  });
});
