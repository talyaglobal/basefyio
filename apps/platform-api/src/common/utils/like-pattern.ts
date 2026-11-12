/**
 * Make user text match literally inside Prisma's `contains` / `startsWith` /
 * `endsWith` filters.
 *
 * On PostgreSQL those filters compile to `LIKE` / `ILIKE` with the value
 * inserted as-is, so `%` matched everything and `_` matched any character:
 * searching users for "%" returned every account. Backslash is PostgreSQL's
 * default LIKE escape character, so prefixing the three special characters
 * with it turns them back into plain text.
 */
export function escapeLikePattern(input: string): string {
  return input.replace(/[\\%_]/g, (c) => `\\${c}`);
}
