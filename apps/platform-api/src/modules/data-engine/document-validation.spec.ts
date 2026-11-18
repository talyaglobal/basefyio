import { BadRequestException, PayloadTooLargeException } from '@nestjs/common';
import { validateDocument } from './document-validation';

const fields = [
  { name: 'firstName', kind: 'scalar', type: 'text', required: true },
  { name: 'age', kind: 'scalar', type: 'number' },
  { name: 'tags', kind: 'array' },
  { name: 'address', kind: 'object', children: [{ name: 'city', kind: 'scalar', type: 'text', required: true }] },
];

describe('validateDocument', () => {
  it('accepts a valid document', () => {
    expect(() => validateDocument({ firstName: 'X', age: 3, tags: [], address: { city: 'a' } }, fields)).not.toThrow();
  });
  it('rejects missing required, wrong types, arrays, empty body', () => {
    expect(() => validateDocument({}, fields)).toThrow(BadRequestException);
    expect(() => validateDocument({ firstName: 'X', address: { city: 'a' }, age: 'otuz' }, fields)).toThrow(BadRequestException);
    expect(() => validateDocument({ firstName: 'X', address: { city: 'a' }, tags: 'no' }, fields)).toThrow(BadRequestException);
    expect(() => validateDocument([{ a: 1 }], fields)).toThrow(BadRequestException);
    expect(() => validateDocument({ firstName: 'X' }, fields)).toThrow(/address.city/);
  });
  it('partial updates skip required checks', () => {
    expect(() => validateDocument({ age: 4 }, fields, { partial: true })).not.toThrow();
    expect(() => validateDocument({ age: 'x' }, fields, { partial: true })).toThrow(BadRequestException);
  });
  it('enforces size, array and depth limits', () => {
    expect(() => validateDocument({ big: 'x'.repeat(1.2 * 1024 * 1024) }, [])).toThrow(PayloadTooLargeException);
    expect(() => validateDocument({ a: new Array(1001).fill(1) }, [])).toThrow(BadRequestException);
    let deep: any = 1;
    for (let i = 0; i < 20; i++) deep = { n: deep };
    expect(() => validateDocument(deep, [])).toThrow(BadRequestException);
  });
});
