import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { mapPgError } from './pg-error.util';

describe('mapPgError', () => {
  it('maps RLS denial (42501) to 403 Forbidden', () => {
    expect(mapPgError({ code: '42501' })).toBeInstanceOf(ForbiddenException);
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

  it('maps undefined_table (42P01) to 404 Not Found', () => {
    expect(mapPgError({ code: '42P01' })).toBeInstanceOf(NotFoundException);
  });

  it('passes an already-typed HttpException straight through', () => {
    const original = new ForbiddenException('x');
    expect(mapPgError(original)).toBe(original);
  });

  it('maps every data exception (class 22) to 400 with Postgres\' own words (#131)', () => {
    const overflow = mapPgError({
      code: '22003',
      message: 'numeric field overflow',
      detail: 'A field with precision 10, scale 2 must round to an absolute value less than 10^8.',
    }) as BadRequestException;
    expect(overflow).toBeInstanceOf(BadRequestException);
    expect(overflow.message).toMatch(/numeric field overflow.*precision 10/);
    expect((overflow.getResponse() as any).code).toBe('22003');
  });

  it('names the check constraint and the type a value did not fit (#134)', () => {
    expect((mapPgError({ code: '23514', constraint: 'price_positive', table: 'items' }) as Error).message)
      .toMatch(/price_positive/);
    expect((mapPgError({ code: '22P02', message: 'invalid input syntax for type uuid: "1"' }) as Error).message)
      .toMatch(/uuid/);
  });

  it('tells a missing grant apart from a policy denial (#134)', () => {
    const grant = mapPgError({ code: '42501', message: 'permission denied for table items' }) as Error;
    expect(grant).toBeInstanceOf(ForbiddenException);
    expect(grant.message).toMatch(/permission denied for table items/);
    expect(grant.message).not.toMatch(/row-level security/);
    const policy = mapPgError({
      code: '42501',
      message: 'new row violates row-level security policy for table "items"',
    }) as Error;
    expect(policy.message).toMatch(/row-level security/);
  });

  it('maps a function that does not fit its call, or raised its own error, to 400', () => {
    expect(mapPgError({ code: '42883', message: 'function f(x => unknown) does not exist' })).toBeInstanceOf(BadRequestException);
    expect(mapPgError({ code: 'P0001', message: 'not allowed' })).toBeInstanceOf(BadRequestException);
  });

  it('keeps a syntax error in SQL the API wrote as a 500', () => {
    const err = { code: '42601', message: 'syntax error' };
    expect(mapPgError(err)).toBe(err);
  });

  it('returns unknown errors unchanged (→ 500)', () => {
    const weird = new Error('boom');
    expect(mapPgError(weird)).toBe(weird);
    expect(mapPgError({ code: '99999' })).toEqual({ code: '99999' });
  });
});
