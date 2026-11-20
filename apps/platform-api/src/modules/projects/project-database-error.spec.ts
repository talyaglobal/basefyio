import { BadRequestException } from '@nestjs/common';
import { mapDdlError } from './project-database.service';

describe('mapDdlError', () => {
  it('maps a missing trigger function to a 400 with the Postgres message', () => {
    const e = Object.assign(new Error('function no_such_fn_xyz() does not exist'), { code: '42883' });
    const out = mapDdlError(e);
    expect(out).toBeInstanceOf(BadRequestException);
    expect((out as BadRequestException).message).toMatch(/no_such_fn_xyz/);
  });
  it('keeps unknown server errors as they are', () => {
    const e = Object.assign(new Error('boom'), { code: 'XX000' });
    expect(mapDdlError(e)).toBe(e);
  });
});
