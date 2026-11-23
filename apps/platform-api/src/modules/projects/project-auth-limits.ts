import { BadRequestException } from '@nestjs/common';

/** Shortest and longest password length a project may require. */
export const PASSWORD_MIN_LENGTH_MIN = 6;
export const PASSWORD_MIN_LENGTH_MAX = 128;

function whole(name: string, value: unknown, min: number, max: number): number {
  const n = typeof value === 'string' && value.trim() !== '' ? Number(value) : value;
  if (typeof n !== 'number' || !Number.isInteger(n) || n < min || n > max) {
    throw new BadRequestException(`${name} must be a whole number between ${min} and ${max}`);
  }
  return n;
}

export function assertPasswordMinLength(value: unknown): number {
  return whole('minPasswordLength', value, PASSWORD_MIN_LENGTH_MIN, PASSWORD_MIN_LENGTH_MAX);
}

/** Bounds for the realm password policy and brute-force fields of PUT /auth/policies. */
export function assertPolicyBody(body: Record<string, any>): void {
  const pw = body.password;
  if (pw !== undefined && pw !== null) {
    if (typeof pw !== 'object') throw new BadRequestException('password must be an object');
    if (pw.minLength !== undefined) whole('password.minLength', pw.minLength, PASSWORD_MIN_LENGTH_MIN, PASSWORD_MIN_LENGTH_MAX);
    if (pw.historyCount !== undefined) whole('password.historyCount', pw.historyCount, 0, 24);
    if (pw.expiryDays !== undefined) whole('password.expiryDays', pw.expiryDays, 0, 3650);
  }
  if (body.failureFactor !== undefined) whole('failureFactor', body.failureFactor, 1, 100);
  if (body.waitIncrementSeconds !== undefined) whole('waitIncrementSeconds', body.waitIncrementSeconds, 0, 86400);
  if (body.maxFailureWaitSeconds !== undefined) whole('maxFailureWaitSeconds', body.maxFailureWaitSeconds, 0, 86400);
  if (body.revokeRefreshToken !== undefined && typeof body.revokeRefreshToken !== 'boolean') {
    throw new BadRequestException('revokeRefreshToken must be true or false');
  }
}
