import { BadRequestException } from '@nestjs/common';
import { assertPasswordMinLength, assertPolicyBody } from './project-auth-limits';

describe('auth limits', () => {
  it.each([0, 1, 5, 129, 99999, 6.5, 'abc', null, undefined])('rejects a minimum length of %p', (v) => {
    expect(() => assertPasswordMinLength(v)).toThrow(BadRequestException);
  });
  it('accepts 6 and 128, also as strings', () => {
    expect(assertPasswordMinLength(6)).toBe(6);
    expect(assertPasswordMinLength('128')).toBe(128);
  });
  it('rejects an out-of-range policy minimum length', () => {
    expect(() => assertPolicyBody({ password: { minLength: 99999 } })).toThrow(BadRequestException);
    expect(() => assertPolicyBody({ password: { minLength: 0 } })).toThrow(BadRequestException);
    expect(() => assertPolicyBody({ password: { minLength: 8, historyCount: 3, expiryDays: 0 } })).not.toThrow();
  });
  it('rejects bad brute-force values', () => {
    expect(() => assertPolicyBody({ failureFactor: 0 })).toThrow(BadRequestException);
    expect(() => assertPolicyBody({ maxFailureWaitSeconds: -1 })).toThrow(BadRequestException);
    expect(() => assertPolicyBody({ failureFactor: 5, waitIncrementSeconds: 60 })).not.toThrow();
  });
});
