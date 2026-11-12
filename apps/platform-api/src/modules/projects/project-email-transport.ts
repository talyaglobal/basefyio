/**
 * Where a project's auth emails go out from: its own SMTP server or API-key
 * provider, or — when none is configured — the platform's email service.
 *
 * ProjectSdkAuthService sends the real emails with the same mapping; the
 * dashboard's "Send test email" uses this to try a configuration (saved or
 * not yet saved) before the project's users depend on it.
 */

export interface ProjectSmtpOptions {
  host: string;
  port: number;
  user: string;
  pass: string;
}

/** The SMTP endpoint for the configured provider, or null for the platform default. */
export function resolveProjectSmtp(cfg: Record<string, any>): ProjectSmtpOptions | null {
  const provider = cfg.emailProvider as string | null;
  if (provider === 'resend' && cfg.resendApiKey) {
    return { host: 'smtp.resend.com', port: 465, user: 'resend', pass: cfg.resendApiKey };
  }
  if (provider === 'sendgrid' && cfg.sendgridApiKey) {
    return { host: 'smtp.sendgrid.net', port: 465, user: 'apikey', pass: cfg.sendgridApiKey };
  }
  if (provider === 'ses' && cfg.sesAccessKey && cfg.sesSecretKey) {
    const region = cfg.sesRegion || 'us-east-1';
    return { host: `email-smtp.${region}.amazonaws.com`, port: 465, user: cfg.sesAccessKey, pass: cfg.sesSecretKey };
  }
  // A host stored without a provider is the shape configs had before the
  // provider column existed; it still means "use this SMTP server".
  if ((provider === 'smtp' || !provider) && cfg.smtpHost) {
    return { host: cfg.smtpHost, port: cfg.smtpPort || 587, user: cfg.smtpUser, pass: cfg.smtpPass };
  }
  return null;
}

/** The From header a project's emails carry. */
export function projectFromAddress(cfg: Record<string, any>, projectName: string): string {
  return cfg.senderEmail
    ? `${cfg.senderName || projectName} <${cfg.senderEmail}>`
    : `${projectName} <noreply@basefyio.com>`;
}

/** nodemailer transport options with timeouts short enough for an interactive test. */
export function smtpTransportOptions(smtp: ProjectSmtpOptions) {
  return {
    host: smtp.host,
    port: smtp.port,
    secure: smtp.port === 465,
    auth: smtp.pass ? { user: smtp.user, pass: smtp.pass } : undefined,
    connectionTimeout: 10_000,
    greetingTimeout: 10_000,
    socketTimeout: 15_000,
  };
}

/**
 * Turn a nodemailer failure into one sentence an operator can act on. The
 * raw messages ("Invalid login: 535-5.7.8 …") are kept after the summary.
 */
export function describeSmtpFailure(err: any, smtp: Pick<ProjectSmtpOptions, 'host' | 'port'>): string {
  const code: string = err?.code ?? '';
  const raw: string = String(err?.response || err?.message || err || '').trim().slice(0, 300);
  const where = `${smtp.host}:${smtp.port}`;
  switch (code) {
    case 'EAUTH':
      return `The SMTP server at ${where} rejected the username or password (${raw}).`;
    case 'ECONNREFUSED':
      return `Nothing accepted the connection at ${where}. Check the host and port.`;
    case 'ENOTFOUND':
    case 'EDNS':
      return `The host "${smtp.host}" could not be resolved. Check the SMTP host.`;
    case 'ETIMEDOUT':
    case 'ECONNECTION':
    case 'ESOCKET':
      return `Could not talk to ${where} (${raw || code}). Check the port and whether the server needs TLS (465) or STARTTLS (587).`;
    case 'EENVELOPE':
      return `The server refused the sender or recipient address (${raw}). Check the sender email.`;
    default:
      return raw ? `Sending failed: ${raw}` : 'Sending failed for an unknown reason.';
  }
}
