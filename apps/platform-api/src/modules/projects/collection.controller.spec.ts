import { BadRequestException } from '@nestjs/common';
import { parseJsonQuery } from './collection.controller';

describe('parseJsonQuery', () => {
  it('returns undefined when the parameter is absent', () => {
    expect(parseJsonQuery('sort', undefined)).toBeUndefined();
    expect(parseJsonQuery('sort', '')).toBeUndefined();
  });

  it('parses valid JSON', () => {
    expect(parseJsonQuery('sort', '{"a":1}')).toEqual({ a: 1 });
  });

  it('answers 400 naming the parameter for malformed JSON', () => {
    expect(() => parseJsonQuery('sort', '{bad')).toThrow(BadRequestException);
    expect(() => parseJsonQuery('sort', '{bad')).toThrow(/"sort" must be valid JSON/);
  });
});
