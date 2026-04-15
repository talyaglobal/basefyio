/** Matches platform-api `ResetPasswordDto` + `AuthService.ensureStrongPassword`. */
export const PLATFORM_PASSWORD_RULES =
  'At least 8 characters, with uppercase, lowercase, a number, and a punctuation character.';

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
