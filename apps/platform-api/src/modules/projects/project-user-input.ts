import { BadRequestException } from '@nestjs/common';
import { isEmail } from 'class-validator';

/**
 * What the dashboard and the admin API accept for a project user (#18). The checks live
 * on the server, so a script gets the same answer as the form.
 */

/** E.164: a plus, a country code that does not start with 0, up to 15 digits in all. */
const E164 = /^\+[1-9]\d{6,14}$/;

export function assertEmail(value: unknown): string {
  const email = String(value ?? '').trim();
  if (!email) throw new BadRequestException('Email is required');
  if (email.length > 320 || !isEmail(email, { require_tld: true })) {
    throw new BadRequestException('Enter a valid e-mail address, for example name@example.com');
  }
  return email;
}

/** `null` clears the number. An empty string does the same. */
export function normalisePhone(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const raw = String(value).trim();
  if (!raw) return null;
  // People type spaces, dashes and brackets; the stored form is the bare E.164 number.
  const phone = raw.replace(/[\s().-]/g, '');
  if (!E164.test(phone)) {
    throw new BadRequestException('Enter the phone number in international format, for example +905551234567');
  }
  return phone;
}

export function assertName(value: unknown, what: string): string | undefined {
  if (value === undefined || value === null) return undefined;
  const name = String(value).trim();
  if (name.length > 100) throw new BadRequestException(`${what} can be at most 100 characters`);
  return name;
}

/** The project's own minimum, and a ceiling that keeps hashing cheap. */
export function assertPassword(value: unknown, minLength: number): string {
  const password = typeof value === 'string' ? value : '';
  if (password.length < minLength) {
    throw new BadRequestException(`Password must be at least ${minLength} characters`);
  }
  if (password.length > 128) throw new BadRequestException('Password can be at most 128 characters');
  return password;
}
