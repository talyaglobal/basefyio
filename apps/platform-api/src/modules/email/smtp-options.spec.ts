import { parseMailbox, realmSmtpServer, smtpTransportOptions } from './smtp-options';

const reader = (values: Record<string, unknown>) => ({ get: (k: string) => values[k] as any });

describe('smtpTransportOptions', () => {
  it('is null without a host, so the service reports mail as not configured', () => {
    expect(smtpTransportOptions(reader({}))).toBeNull();
    expect(smtpTransportOptions(reader({ 'mail.smtp.host': '  ' }))).toBeNull();
  });

  it('defaults to STARTTLS on 587 and requires it, verifying the certificate', () => {
    const o: any = smtpTransportOptions(reader({ 'mail.smtp.host': 'smtp.example.test', 'mail.smtp.user': 'u', 'mail.smtp.password': 'p' }));
    expect(o).toMatchObject({ host: 'smtp.example.test', port: 587, secure: false, requireTLS: true, ignoreTLS: false, auth: { user: 'u', pass: 'p' } });
    expect(o.tls.rejectUnauthorized).toBe(true);
  });

  it('speaks implicit TLS on 465, or plain text on a trusted relay, and may accept a self-signed certificate', () => {
    const tls: any = smtpTransportOptions(reader({ 'mail.smtp.host': 'h', 'mail.smtp.security': 'tls' }));
    expect(tls).toMatchObject({ port: 465, secure: true, requireTLS: false });
    expect(tls.auth).toBeUndefined();

    const plain: any = smtpTransportOptions(
      reader({ 'mail.smtp.host': 'h', 'mail.smtp.security': 'none', 'mail.smtp.port': 25, 'mail.smtp.rejectUnauthorized': false }),
    );
    expect(plain).toMatchObject({ port: 25, secure: false, requireTLS: false, ignoreTLS: true });
    expect(plain.tls.rejectUnauthorized).toBe(false);
  });
});

describe('parseMailbox', () => {
  it('splits a display name from the address and accepts a bare address', () => {
    expect(parseMailbox('basefyio <noreply@example.test>')).toEqual({ name: 'basefyio', address: 'noreply@example.test' });
    expect(parseMailbox('"Marina Ops" <ops@example.test>')).toEqual({ name: 'Marina Ops', address: 'ops@example.test' });
    expect(parseMailbox('ops@example.test')).toEqual({ name: '', address: 'ops@example.test' });
  });
});

describe('realmSmtpServer', () => {
  const smtp = {
    'mail.transport': 'smtp',
    'mail.smtp.host': 'smtp.example.test',
    'mail.smtp.port': 587,
    'mail.smtp.user': 'mailer',
    'mail.smtp.password': 'secret',
    'mail.from': 'Marina <noreply@example.test>',
    'resend.replyTo': 'support@example.test',
  };

  it('stays off unless KEYCLOAK_REALM_SMTP=true and the platform sends over SMTP — production keeps its realms untouched', () => {
    expect(realmSmtpServer(reader(smtp))).toBeNull();
    expect(realmSmtpServer(reader({ ...smtp, 'keycloak.realmSmtp': true, 'mail.transport': 'resend' }))).toBeNull();
    expect(realmSmtpServer(reader({ ...smtp, 'keycloak.realmSmtp': true, 'mail.smtp.host': '' }))).toBeNull();
  });

  it('describes the same server the way Keycloak stores it: every value a string', () => {
    expect(realmSmtpServer(reader({ ...smtp, 'keycloak.realmSmtp': true }))).toEqual({
      host: 'smtp.example.test',
      port: '587',
      from: 'noreply@example.test',
      fromDisplayName: 'Marina',
      replyTo: 'support@example.test',
      ssl: 'false',
      starttls: 'true',
      auth: 'true',
      user: 'mailer',
      password: 'secret',
    });
  });
});
