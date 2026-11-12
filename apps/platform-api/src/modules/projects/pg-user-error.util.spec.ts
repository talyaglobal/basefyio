import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import {
  describePgError,
  isPgError,
  lineAndColumn,
  toUserFacingPgError,
} from './pg-user-error.util';

function pgError(fields: Record<string, unknown>): Error {
  return Object.assign(new Error(String(fields.message ?? 'boom')), fields);
}

describe('toUserFacingPgError', () => {
  it('turns an unknown column into a 400 that names the column', () => {
    const out = toUserFacingPgError(
      pgError({ code: '42703', message: 'column "nope" does not exist' }),
      { prefix: 'Failed to create index' },
    );
    expect(out).toBeInstanceOf(BadRequestException);
    expect((out as BadRequestException).message).toBe(
      'Failed to create index: column "nope" does not exist',
    );
  });

  it('reports the line and column of a syntax error in a multi-line statement', () => {
    const sql = 'CREATE FUNCTION f()\nRETURNS int\nLANGUAG sql AS $$ SELECT 1 $$';
    const position = sql.indexOf('LANGUAG') + 1;
    const out = toUserFacingPgError(
      pgError({ code: '42601', message: 'syntax error at or near "LANGUAG"', position: String(position) }),
      { sql },
    ) as BadRequestException;
    expect(out).toBeInstanceOf(BadRequestException);
    expect(out.message).toContain('syntax error at or near "LANGUAG" (line 3, column 1)');
  });

  it('answers "already exists" with 409 and keeps the detail', () => {
    const out = toUserFacingPgError(
      pgError({ code: '42P07', message: 'relation "select" already exists' }),
    );
    expect(out).toBeInstanceOf(ConflictException);
    const dup = toUserFacingPgError(
      pgError({ code: '23505', message: 'duplicate key value violates unique constraint "t_pkey"', detail: 'Key (id)=(1) already exists.' }),
    ) as ConflictException;
    expect(dup.message).toContain('Key (id)=(1) already exists.');
  });

  it('maps privilege and missing-table errors to 403 and 404', () => {
    expect(toUserFacingPgError(pgError({ code: '42501', message: 'permission denied' }))).toBeInstanceOf(ForbiddenException);
    expect(toUserFacingPgError(pgError({ code: '42P01', message: 'relation "x" does not exist' }))).toBeInstanceOf(NotFoundException);
  });

  it('treats a PL/pgSQL RAISE and a cancelled statement as the caller\'s', () => {
    expect(toUserFacingPgError(pgError({ code: 'P0001', message: 'custom' }))).toBeInstanceOf(BadRequestException);
    expect(toUserFacingPgError(pgError({ code: '57014', message: 'canceling statement due to statement timeout' }))).toBeInstanceOf(BadRequestException);
  });

  it('leaves server-side failures alone so they still surface as 500s', () => {
    const conn = Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' });
    expect(toUserFacingPgError(conn)).toBe(conn);
    const internal = pgError({ code: 'XX000', message: 'internal error' });
    expect(toUserFacingPgError(internal)).toBe(internal);
    const plain = new Error('bug');
    expect(toUserFacingPgError(plain)).toBe(plain);
  });

  it('passes an HttpException through unchanged', () => {
    const e = new NotFoundException('Project not found');
    expect(toUserFacingPgError(e)).toBe(e);
  });
});

describe('describePgError / helpers', () => {
  it('adds the hint', () => {
    expect(
      describePgError({ code: '42883', message: 'function f(integer) does not exist', hint: 'No function matches.' }),
    ).toBe('function f(integer) does not exist Hint: No function matches.');
  });

  it('computes 1-based line and column', () => {
    expect(lineAndColumn('a\nbc\ndef', 5)).toEqual({ line: 2, column: 3 });
    expect(lineAndColumn('select', 1)).toEqual({ line: 1, column: 1 });
  });

  it('recognises only SQLSTATE-shaped codes', () => {
    expect(isPgError({ code: '42601' })).toBe(true);
    expect(isPgError({ code: 'ECONNRESET' })).toBe(false);
    expect(isPgError(null)).toBe(false);
  });
});
