/** Whether the project detail page shows the "turn on TLS" notice. */
export function showDbTlsNotice(project: { dbTlsNoticeAt?: string | null } | null | undefined): boolean {
  return !!project?.dbTlsNoticeAt;
}

export const DB_TLS_DOCS_URL = `${process.env.NEXT_PUBLIC_DOCS_URL || 'https://basefyio.com'}/docs/connect`;
