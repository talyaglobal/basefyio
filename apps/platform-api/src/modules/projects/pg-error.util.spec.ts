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

  it('returns unknown errors unchanged (→ 500)', () => {
    const weird = new Error('boom');
    expect(mapPgError(weird)).toBe(weird);
    expect(mapPgError({ code: '99999' })).toEqual({ code: '99999' });
  });
});
