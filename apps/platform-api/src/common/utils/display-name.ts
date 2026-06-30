/** Returns "First Last" or falls back to the email local-part when no name is set */
export function getDisplayName(user: {
  firstName?: string | null;
  lastName?: string | null;
  email: string;
}): string {
  const full = [user.firstName, user.lastName].filter(Boolean).join(' ').trim();
  return full || user.email.split('@')[0];
}
