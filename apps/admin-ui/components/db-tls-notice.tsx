'use client';

import { ShieldAlert } from 'lucide-react';
import { DB_TLS_DOCS_URL, showDbTlsNotice } from '@/lib/db-tls-notice';

/**
 * The project detail page's TLS notice. Same amber bar as the dashboard's card warning, but
 * not dismissible: it goes away by itself once the platform sees a TLS connection from the
 * project's database user.
 */
export function DbTlsNotice({ project }: { project: { dbTlsNoticeAt?: string | null } | null }) {
  if (!showDbTlsNotice(project)) return null;
  return (
    <div
      role="alert"
      data-testid="db-tls-notice"
      className="flex shrink-0 items-center justify-between gap-4 border-b border-amber-800/50 bg-amber-950/40 px-6 py-3"
    >
      <div className="flex items-start gap-3 text-sm text-amber-200">
        <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0" />
        <span>
          <strong>Turn on TLS for your database connection.</strong>{' '}
          Database connections to db.basefyio.com now require TLS. Apps that connect without encryption are
          refused. Add <code className="font-mono">sslmode=require</code> to your connection string; host, port,
          user and password stay the same.
        </span>
      </div>
      <div className="flex shrink-0 items-center gap-3">
        <a
          href={DB_TLS_DOCS_URL}
          target="_blank"
          rel="noopener noreferrer"
          className="rounded-lg bg-amber-600 px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-amber-500"
        >
          Connection guide
        </a>
      </div>
    </div>
  );
}
