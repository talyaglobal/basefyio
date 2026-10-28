import { BadRequestException, ForbiddenException, UnauthorizedException } from '@nestjs/common';
import { PostgrestCompatFilter } from './compat.filter';
import {
  PostgrestHttpError,
  isPgError,
  notAcceptableObject,
  parseErrorToPostgrest,
  pgToPostgrest,
  sqlstateStatus,
} from './errors';
import { PostgrestParseError } from './types';

describe('sqlstateStatus — PostgREST status for a SQLSTATE', () => {
  it.each([
    ['42P01', 404],
    ['42883', 404],
    ['23505', 409],
    ['23503', 409],
    ['25006', 405],
    ['08006', 503],
    ['53300', 503],
    ['54001', 413],
    ['28P01', 403],
    ['0L000', 403],
    ['P0001', 400],
    ['P0002', 500],
    ['XX000', 500],
    ['42P17', 500],
    ['40001', 500],
    ['23502', 400],
    ['22P02', 400],
    ['42703', 400],
  ])('%s → %i', (code, status) => {
    expect(sqlstateStatus(code)).toBe(status);
  });

  it('answers 401 for insufficient_privilege from the anonymous role, 403 otherwise', () => {
    expect(sqlstateStatus('42501', 'anon')).toBe(401);
    expect(sqlstateStatus('42501', 'authenticated')).toBe(403);
    expect(sqlstateStatus('42501')).toBe(403);
  });
});

describe('pgToPostgrest', () => {
  it('keeps code, message, detail and hint, with nulls where Postgres sent nothing', () => {
    const e = pgToPostgrest(
      { code: '23505', message: 'duplicate key value violates unique constraint "x"', detail: 'Key (id)=(1) already exists.' },
      'authenticated',
    ) as PostgrestHttpError;
    expect(e).toBeInstanceOf(PostgrestHttpError);
    expect(e.getStatus()).toBe(409);
    expect(e.body).toEqual({
      code: '23505',
      message: 'duplicate key value violates unique constraint "x"',
      details: 'Key (id)=(1) already exists.',
      hint: null,
    });
  });

  it('passes an HttpException and a non-Postgres error through untouched', () => {
    const http = new ForbiddenException('x');
    expect(pgToPostgrest(http)).toBe(http);
    const plain = new Error('boom');
    expect(pgToPostgrest(plain)).toBe(plain);
    expect(isPgError({ code: 'not-a-sqlstate' })).toBe(false);
  });
});

describe('parse / object errors', () => {
  it('gives a missing relation 404 PGRST205 and a missing column 400 PGRST204', () => {
    const rel = parseErrorToPostgrest(new PostgrestParseError('Relation "x" not found', undefined, 'PGRST205'));
    expect(rel.getStatus()).toBe(404);
    expect(rel.body.code).toBe('PGRST205');
    const col = parseErrorToPostgrest(new PostgrestParseError('Column "y" does not exist', undefined, 'PGRST204'));
    expect(col.getStatus()).toBe(400);
  });

  it('describes a .single() miss the way PostgREST does', () => {
    expect(notAcceptableObject(0).body).toEqual({
      code: 'PGRST116',
      message: 'JSON object requested, multiple (or no) rows returned',
      details: 'The result contains 0 rows',
      hint: null,
    });
    expect(notAcceptableObject(3).body.details).toBe('3 rows');
    expect(notAcceptableObject(3).getStatus()).toBe(406);
  });
});

/** A fake ArgumentsHost around a plain request/response pair. */
function host(headers: Record<string, string>, extra: Record<string, unknown> = {}) {
  const sent: { status?: number; body?: unknown; type?: string } = {};
  const res: any = {
    status: jest.fn((s: number) => { sent.status = s; return res; }),
    type: jest.fn((t: string) => { sent.type = t; return res; }),
    send: jest.fn((b: string) => { sent.body = JSON.parse(b); return res; }),
    json: jest.fn((b: unknown) => { sent.body = b; return res; }),
  };
  const req = { headers, ...extra };
  const h: any = { switchToHttp: () => ({ getRequest: () => req, getResponse: () => res }) };
  return { h, sent };
}

describe('PostgrestCompatFilter', () => {
  const filter = new PostgrestCompatFilter();

  it('leaves a non-compat caller with the platform body, byte for byte', () => {
    const { h, sent } = host({});
    filter.catch(new UnauthorizedException('Missing apikey'), h);
    expect(sent.status).toBe(401);
    expect(sent.body).toMatchObject({ statusCode: 401, message: 'Missing apikey' });
    expect(Object.keys(sent.body as object).sort()).toEqual(['message', 'statusCode', 'timestamp']);
  });

  it('writes {code, message, details, hint} for a compat caller, even for a guard error', () => {
    const { h, sent } = host({ 'accept-profile': 'public' });
    filter.catch(new UnauthorizedException('Missing apikey'), h);
    expect(sent.status).toBe(401);
    expect(sent.body).toEqual({ code: 'PGRST301', message: 'Missing apikey', details: null, hint: null });
  });

  it('trusts the guard’s decision on the request when it made one', () => {
    const { h, sent } = host({ 'accept-profile': 'public' }, { supabaseCompat: false });
    filter.catch(new BadRequestException('nope'), h);
    expect(sent.body).toMatchObject({ statusCode: 400 });
  });

  it('upgrades a PGRST-coded 400 to the status PostgREST uses for that code', () => {
    const { h, sent } = host({ 'x-client-info': 'supabase-js-node/2.0.0' });
    filter.catch(new BadRequestException({ message: 'Relation "x" not found', code: 'PGRST205' }), h);
    expect(sent.status).toBe(404);
    expect(sent.body).toEqual({ code: 'PGRST205', message: 'Relation "x" not found', details: null, hint: null });
  });

  it('renders a raw Postgres error with its SQLSTATE and the caller’s role', () => {
    const { h, sent } = host({ 'accept-profile': 'public' }, { apiKeyPayload: { dbRole: 'anon' } });
    filter.catch({ code: '42501', message: 'permission denied for table posts' }, h);
    expect(sent.status).toBe(401);
    expect(sent.body).toEqual({ code: '42501', message: 'permission denied for table posts', details: null, hint: null });
  });

  it('never leaks an unknown error’s message', () => {
    const { h, sent } = host({ 'accept-profile': 'public' });
    filter.catch(new Error('secret internals'), h);
    expect(sent.status).toBe(500);
    expect(sent.body).toEqual({ code: 'XX000', message: 'Internal server error', details: null, hint: null });
  });
});
