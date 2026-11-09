/** Escapes LIKE wildcards so a search for "%" or "_" is plain text (Prisma `contains` passes the value verbatim). */
export function escapeLike(q: string): string {
  return q.replace(/[\\%_]/g, (c) => '\\' + c);
}
