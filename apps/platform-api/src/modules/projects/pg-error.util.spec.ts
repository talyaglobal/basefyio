import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { mapPgError, mapRestError } from './pg-error.util';
import { PostgrestParseError } from './postgrest/types';

describe('mapPgError', () => {
  it('maps RLS denial (42501) to 403 Forbidden', () => {
    expect(mapPgError({ code: '42501' })).toBeInstanceOf(ForbiddenException);
  });

  it('maps a write inside a read-only call (25006, a GET/HEAD rpc) to 405 with the way out', () => {
    const err = mapPgError({ code: '25006' }) as any;
    expect(err.getStatus()).toBe(405);
    expect(err.message).toMatch(/POST/);
  });

  it('maps unique/foreign-key violations to 409 Conflict', () => {
    expect(mapPgError({ code: '23505' })).toBeInstanceOf(ConflictException);
    expect(mapPgError({ code: '23503' })).toBeInstanceOf(ConflictException);
  });

  it('maps constraint / bad-input codes to 400 Bad Request', () => {
    expect(mapPgError({ code: '23502' })).toBeInstanceOf(BadRequestException);
    expect(mapPgError({ code: '23514' })).toBeInstanceOf(BadRequestException);
    expect(mapPgError({ code: '22P02' })).toBeInstanceOf(BadRequestException);
    expect(mapPgError({ code: '42703' })).toBeInstanceOf(BadRequestException);
  });

  it('says whether a grant or a row policy refused the write', () => {
    expect((mapPgError({ code: '42501', message: 'permission denied for table items' }) as any).message).toMatch(
      /permission denied for table items.*grant is missing/,
    );
    expect((mapPgError({ code: '42501', message: 'new row violates row-level security policy for table "items"' }) as any).message).toBe(
      'Permission denied by row-level security policy',
    );
  });

  it('names the constraint a check violation broke and what a bad value was', () => {
    expect((mapPgError({ code: '23514', constraint: 'items_qty_check' }) as any).message).toBe('Check constraint "items_qty_check" violated');
    expect((mapPgError({ code: '22P02', message: 'invalid input syntax for type integer: "abc"' }) as any).message).toBe(
      'Invalid input value: invalid input syntax for type integer: "abc"',
    );
  });

  it('maps undefined_table (42P01) to 404 Not Found', () => {
    expect(mapPgError({ code: '42P01' })).toBeInstanceOf(NotFoundException);
  });

  it('passes an already-typed HttpException straight through', () => {
    const original = new ForbiddenException('x');
    expect(mapPgError(original)).toBe(original);
  });

  it('returns unknown errors unchanged (→ 500)', () => {
    const weird = new Error('boom');
    expect(mapPgError(weird)).toBe(weird);
    expect(mapPgError({ code: '99999' })).toEqual({ code: '99999' });
  });
});

describe('mapPgError — raise exception', () => {
  it('turns P0001 into a 400 that carries the function\'s own message', () => {
    const out = mapPgError({ code: 'P0001', message: 'Not enough coins' }) as any;
    expect(out).toBeInstanceOf(BadRequestException);
    expect(out.message).toBe('Not enough coins');
  });

  it('has a fallback when the message is empty', () => {
    expect((mapPgError({ code: 'P0001' }) as any).message).toBe('The function raised an error');
  });

  it('still leaves other PL/pgSQL codes alone', () => {
    const err = { code: 'P0002', message: 'no data found' };
    expect(mapPgError(err)).toBe(err);
  });
});

describe('mapRestError — bad REST input is never a 500', () => {
  it('maps a numeric overflow (22003) to 400 and keeps the short Postgres description', () => {
    const err = mapRestError({ code: '22003', message: 'numeric field overflow', detail: 'precision 10, scale 2 ... secret' }) as any;
    expect(err).toBeInstanceOf(BadRequestException);
    expect(err.message).toBe('Invalid input value: numeric field overflow');
    expect(JSON.stringify(err.getResponse())).not.toMatch(/secret/);
  });

  it('maps other data exceptions (22xxx) to 400', () => {
    expect(mapRestError({ code: '22001', message: 'value too long for type character varying(5)' })).toBeInstanceOf(BadRequestException);
    expect(mapRestError({ code: '22012', message: 'division by zero' })).toBeInstanceOf(BadRequestException);
  });

  it('maps a malformed statement (42xxx) to 400 with a fixed message that names nothing', () => {
    const err = mapRestError({ code: '42804', message: 'column "secret_col" is of type integer but expression is of type text' }) as any;
    expect(err).toBeInstanceOf(BadRequestException);
    expect(err.message).toBe('The request is not valid for this resource');
  });

  it('maps an unmapped integrity failure (23xxx) to 409 without the constraint name', () => {
    const err = mapRestError({ code: '23P01', message: 'conflicting key value violates exclusion constraint "internal_x"' }) as any;
    expect(err.getStatus()).toBe(409);
    expect(err.message).not.toMatch(/internal_x/);
  });

  it('maps a parse error that escaped to 400 with its code', () => {
    const err = mapRestError(new PostgrestParseError('Unknown operator "foo"', undefined, 'PGRST100')) as any;
    expect(err).toBeInstanceOf(BadRequestException);
    expect(err.getResponse()).toMatchObject({ code: 'PGRST100', message: 'Unknown operator "foo"' });
  });

  it('keeps the existing mappings and leaves real server faults alone', () => {
    expect(mapRestError({ code: '23505', detail: 'dup' })).toBeInstanceOf(ConflictException);
    const fault = { code: '53300', message: 'too many connections' };
    expect(mapRestError(fault)).toBe(fault);
    const plain = new Error('boom');
    expect(mapRestError(plain)).toBe(plain);
  });
});
