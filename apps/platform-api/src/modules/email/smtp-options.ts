import type * as nodemailer from 'nodemailer';

/** The slice of ConfigService the helpers need, so they stay testable without Nest. */
export interface ConfigReader {
  get<T = unknown>(key: string): T | undefined;
}

export type SmtpSecurity = 'starttls' | 'tls' | 'none';

function security(config: ConfigReader): SmtpSecurity {
  const v = String(config.get<string>('mail.smtp.security') || 'starttls').toLowerCase();
  return v === 'tls' || v === 'none' ? v : 'starttls';
}

/**
 * nodemailer options for MAIL_TRANSPORT=smtp, or null when SMTP_HOST is empty.
 *
 * starttls (default): plain connection upgraded with STARTTLS, which is then
 * required — a server that does not offer it is refused rather than spoken to
 * in clear text. tls: implicit TLS from the first byte (port 465). none: no
 * encryption at all, for a relay on a trusted local network only.
 */
export function smtpTransportOptions(config: ConfigReader): nodemailer.TransportOptions | null {
  const host = (config.get<string>('mail.smtp.host') || '').trim();
  if (!host) return null;
  const mode = security(config);
  const user = config.get<string>('mail.smtp.user') || '';
  const pass = config.get<string>('mail.smtp.password') || '';
  return {
    host,
    port: Number(config.get<number>('mail.smtp.port')) || (mode === 'tls' ? 465 : 587),
    secure: mode === 'tls',
    requireTLS: mode === 'starttls',
    ignoreTLS: mode === 'none',
    ...(user ? { auth: { user, pass } } : {}),
    tls: { rejectUnauthorized: config.get<boolean>('mail.smtp.rejectUnauthorized') !== false },
    connectionTimeout: 15_000,
    greetingTimeout: 15_000,
    socketTimeout: 30_000,
  } as nodemailer.TransportOptions;
}

/** "Name <address>" → { name, address }; a bare address has no name. */
export function parseMailbox(value: string): { name: string; address: string } {
  const m = /^\s*"?([^"<]*?)"?\s*<\s*([^>]+?)\s*>\s*$/.exec(value || '');
  if (m) return { name: m[1].trim(), address: m[2].trim() };
  return { name: '', address: (value || '').trim() };
}

/**
 * The realm representation's `smtpServer` block for the same server, or null
 * unless KEYCLOAK_REALM_SMTP=true and the platform sends over SMTP. Keycloak
 * stores every value as a string.
 */
export function realmSmtpServer(config: ConfigReader): Record<string, string> | null {
  if (config.get<boolean>('keycloak.realmSmtp') !== true) return null;
  if ((config.get<string>('mail.transport') || 'resend') !== 'smtp') return null;
  const host = (config.get<string>('mail.smtp.host') || '').trim();
  if (!host) return null;
  const mode = security(config);
  const from = parseMailbox(config.get<string>('mail.from') || config.get<string>('resend.fromEmail') || '');
  const replyTo = parseMailbox(config.get<string>('resend.replyTo') || '').address;
  const user = config.get<string>('mail.smtp.user') || '';
  const port = Number(config.get<number>('mail.smtp.port')) || (mode === 'tls' ? 465 : 587);
  return {
    host,
    port: String(port),
    from: from.address,
    fromDisplayName: from.name,
    ...(replyTo ? { replyTo } : {}),
    ssl: mode === 'tls' ? 'true' : 'false',
    starttls: mode === 'starttls' ? 'true' : 'false',
    auth: user ? 'true' : 'false',
    ...(user ? { user, password: config.get<string>('mail.smtp.password') || '' } : {}),
  };
}
