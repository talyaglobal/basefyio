/** Matches platform-api `ResetPasswordDto` + `AuthService.ensureStrongPassword`. */
export const PLATFORM_PASSWORD_RULES =
  'At least 8 characters, with uppercase, lowercase, a number, and a punctuation character.';

/**
 * The same rules as one entry each, for a checklist that ticks while the user
 * types. The regexes are the server's: an ASCII punctuation character counts,
 * a space or a letter outside A–Z does not.
 */
export const PLATFORM_PASSWORD_CHECKS: ReadonlyArray<{ label: string; test: (password: string) => boolean }> = [
  { label: 'At least 8 characters', test: (p) => p.length >= 8 },
  { label: 'An uppercase letter (A–Z)', test: (p) => /[A-Z]/.test(p) },
  { label: 'A lowercase letter (a–z)', test: (p) => /[a-z]/.test(p) },
  { label: 'A number (0–9)', test: (p) => /[0-9]/.test(p) },
  { label: 'A punctuation character, such as ! ? # @ or -', test: (p) => /[!-/:-@[-`{-~]/.test(p) },
];

export function validatePlatformPassword(password: string): string | null {
  if (password.length < 8) {
    return 'Password must be at least 8 characters long.';
  }
  if (!/[A-Z]/.test(password)) {
    return 'Password must include at least one uppercase letter.';
  }
  if (!/[a-z]/.test(password)) {
    return 'Password must include at least one lowercase letter.';
  }
  if (!/[0-9]/.test(password)) {
    return 'Password must include at least one number.';
  }
  if (!/[!-/:-@[-`{-~]/.test(password)) {
    return 'Password must include at least one punctuation character.';
  }
  return null;
}
