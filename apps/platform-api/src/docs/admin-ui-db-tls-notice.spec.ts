import { readFileSync } from 'fs';
import { join } from 'path';
import { DB_TLS_DOCS_URL, showDbTlsNotice } from '../../../admin-ui/lib/db-tls-notice';

/**
 * The project detail page warns while `dbTlsNoticeAt` is set (operations marks projects whose
 * app connects to the pooler without TLS; DbTlsNoticeService clears it). The notice sits in
 * the project layout, so every tab shows it, and it cannot be dismissed.
 */
const UI_ROOT = join(__dirname, '../../../admin-ui');

describe('admin-ui database TLS notice', () => {
  it('shows only while the marker is set', () => {
    expect(showDbTlsNotice({ dbTlsNoticeAt: '2026-11-28T10:00:00.000Z' })).toBe(true);
    expect(showDbTlsNotice({ dbTlsNoticeAt: null })).toBe(false);
    expect(showDbTlsNotice({})).toBe(false);
    expect(showDbTlsNotice(null)).toBe(false);
    expect(showDbTlsNotice(undefined)).toBe(false);
  });

  it('links to the connection guide', () => {
    expect(DB_TLS_DOCS_URL).toMatch(/\/docs\/connect$/);
  });

  it('is rendered by the project layout, above every tab', () => {
    const layout = readFileSync(join(UI_ROOT, 'app/dashboard/projects/[id]/layout.tsx'), 'utf8');
    expect(layout).toMatch(/<DbTlsNotice project=\{project\} \/>/);
  });

  it('is amber, carries the agreed copy and cannot be dismissed', () => {
    const src = readFileSync(join(UI_ROOT, 'components/db-tls-notice.tsx'), 'utf8');
    expect(src).toContain('Turn on TLS for your database connection');
    expect(src).toContain('sslmode=require');
    expect(src).toMatch(/bg-amber-950\/40/);
    expect(src).not.toMatch(/Dismiss|onClick/);
  });
});
