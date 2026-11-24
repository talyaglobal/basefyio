import { BadRequestException } from '@nestjs/common';
import { assertEmail, assertName, assertPassword, normalisePhone } from './project-user-input';

/** #18: what the user form and the admin API accept. */
describe('assertEmail', () => {
  it('accepts an ordinary address and trims it', () => {
    expect(assertEmail('  ada@example.com ')).toBe('ada@example.com');
    expect(assertEmail('first.last+tag@sub.example.co.uk')).toBe('first.last+tag@sub.example.co.uk');
  });
  it.each(['qa_e2e_bad@example', 'no-at-sign', '@example.com', 'a@b', 'a b@example.com', '', '   ', 'x@'])(
    'refuses %p',
    (v) => expect(() => assertEmail(v)).toThrow(BadRequestException),
  );
  it('refuses an address longer than 320 characters', () => {
    expect(() => assertEmail(`${'a'.repeat(310)}@example.com`)).toThrow(BadRequestException);
  });
});

describe('normalisePhone', () => {
  it('keeps E.164 and strips the punctuation people type', () => {
    expect(normalisePhone('+905551234567')).toBe('+905551234567');
    expect(normalisePhone('+90 (555) 123-45-67')).toBe('+905551234567');
  });
  it('clears on empty, null or undefined', () => {
    expect(normalisePhone('')).toBeNull();
    expect(normalisePhone('   ')).toBeNull();
    expect(normalisePhone(null)).toBeNull();
    expect(normalisePhone(undefined)).toBeNull();
  });
  it.each(['abc-not-phone', '05551234567', '+0555123456', '+1', '+9055512345678901234', '+90555abc4567'])(
    'refuses %p',
    (v) => expect(() => normalisePhone(v)).toThrow(BadRequestException),
  );
});

describe('assertPassword', () => {
  it('uses the project minimum', () => {
    expect(assertPassword('123456', 6)).toBe('123456');
    expect(() => assertPassword('123456', 8)).toThrow(/at least 8/);
    expect(() => assertPassword(undefined, 6)).toThrow(BadRequestException);
    expect(() => assertPassword('x'.repeat(129), 6)).toThrow(/at most 128/);
  });
});

describe('assertName', () => {
  it('trims, leaves absent names alone and caps the length', () => {
    expect(assertName(' Ada ', 'First name')).toBe('Ada');
    expect(assertName(undefined, 'First name')).toBeUndefined();
    expect(() => assertName('x'.repeat(101), 'First name')).toThrow(/at most 100/);
  });
});
