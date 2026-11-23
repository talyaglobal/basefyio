import { PostgrestCompatFilter } from './compat.filter';
import { PostgrestParseError } from './types';

function run(exception: unknown) {
  const out: { status?: number; body?: any } = {};
  const res: any = { status: (s: number) => ((out.status = s), res), json: (b: unknown) => ((out.body = b), res) };
  const host: any = { switchToHttp: () => ({ getRequest: () => ({ headers: {}, supabaseCompat: false }), getResponse: () => res }) };
  new PostgrestCompatFilter().catch(exception, host);
  return out;
}

describe('PostgrestCompatFilter for a plain REST client (#131)', () => {
  it('answers a parse error that reached it as 400 with its code', () => {
    const out = run(new PostgrestParseError('Unknown operator "foo" on "id"'));
    expect(out.status).toBe(400);
    expect(out.body).toMatchObject({ statusCode: 400, code: 'PGRST100' });
  });

  it('answers a raw Postgres data error as 400 and never leaks internals', () => {
    const out = run({ code: '22003', message: 'numeric field overflow', detail: 'internal detail' });
    expect(out.status).toBe(400);
    expect(JSON.stringify(out.body)).not.toContain('internal detail');
  });

  it('keeps an unknown error a generic 500', () => {
    const out = run(new Error('relation "secret" blew up'));
    expect(out.status).toBe(500);
    expect(out.body.message).toBe('Internal server error');
  });
});
