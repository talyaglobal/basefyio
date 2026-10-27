const sendMail = jest.fn();
const verify = jest.fn();
const createTransport = jest.fn(() => ({ sendMail, verify }));
jest.mock('nodemailer', () => ({ createTransport: (...a: unknown[]) => (createTransport as any)(...a) }));

const resendSend = jest.fn();
const resendDomains = jest.fn();
const ResendCtor = jest.fn(() => ({ emails: { send: resendSend }, domains: { list: resendDomains } }));
jest.mock('resend', () => ({ Resend: function (...a: unknown[]) { return (ResendCtor as any)(...a); } }));

import { EmailService } from './email.service';

function makeService(values: Record<string, unknown>) {
  const config = { get: (k: string) => values[k] as any };
  return new EmailService(config as any, { increment: jest.fn() } as any);
}

const BASE = {
  appUrl: 'https://app.example.test',
  'resend.fromEmail': 'basefyio <noreply@example.test>',
  'resend.replyTo': 'support@example.test',
};

beforeEach(() => {
  jest.clearAllMocks();
});

describe('EmailService transports', () => {
  it('keeps the HTTP API path by default: no SMTP transport is created', async () => {
    resendSend.mockResolvedValue({ data: { id: 'm1' }, error: null });
    resendDomains.mockResolvedValue({ data: [], error: null });
    const svc = makeService({ ...BASE, 'resend.apiKey': 're_x' });
    await svc.onModuleInit();
    await svc.sendRawHtml('a@example.test', 'Hi', '<p>hi</p>');
    expect(ResendCtor).toHaveBeenCalledWith('re_x');
    expect(createTransport).not.toHaveBeenCalled();
    expect(resendSend).toHaveBeenCalledWith(expect.objectContaining({ from: BASE['resend.fromEmail'], to: 'a@example.test' }));
    expect(svc.getDeliverability().state).toBe('ok');
  });

  it('sends over SMTP when MAIL_TRANSPORT=smtp, from MAIL_FROM, and never touches the HTTP API', async () => {
    verify.mockResolvedValue(true);
    sendMail.mockResolvedValue({ messageId: '<x@y>' });
    const svc = makeService({
      ...BASE,
      'resend.apiKey': 're_should_not_be_used',
      'mail.transport': 'smtp',
      'mail.from': 'Marina <noreply@marina.test>',
      'mail.smtp.host': 'smtp.marina.test',
      'mail.smtp.port': 587,
    });
    await svc.onModuleInit();
    expect(svc.getDeliverability().state).toBe('ok');
    await svc.sendRawHtml('b@example.test', 'Reset', '<p>reset</p>');
    expect(ResendCtor).not.toHaveBeenCalled();
    expect(createTransport).toHaveBeenCalledWith(expect.objectContaining({ host: 'smtp.marina.test', port: 587, requireTLS: true }));
    expect(sendMail).toHaveBeenCalledWith(
      expect.objectContaining({ from: 'Marina <noreply@marina.test>', to: 'b@example.test', replyTo: 'support@example.test', subject: 'Reset' }),
    );
  });

  it('reports a refused login as failing, and an unreachable server as unchecked', async () => {
    verify.mockRejectedValueOnce(Object.assign(new Error('535 bad credentials'), { code: 'EAUTH' }));
    const refused = makeService({ ...BASE, 'mail.transport': 'smtp', 'mail.smtp.host': 'smtp.marina.test' });
    await refused.onModuleInit();
    expect(refused.getDeliverability().state).toBe('failing');

    verify.mockRejectedValueOnce(Object.assign(new Error('connect ECONNREFUSED'), { code: 'ESOCKET' }));
    const unreachable = makeService({ ...BASE, 'mail.transport': 'smtp', 'mail.smtp.host': 'smtp.marina.test' });
    await unreachable.onModuleInit();
    expect(unreachable.getDeliverability().state).toBe('unchecked');
  });

  it('says not-configured when SMTP is chosen without a host, and sends nothing', async () => {
    const svc = makeService({ ...BASE, 'mail.transport': 'smtp' });
    await svc.onModuleInit();
    expect(svc.getDeliverability().state).toBe('not-configured');
    expect(await svc.sendRawHtml('c@example.test', 'x', 'y')).toBeNull();
    expect(sendMail).not.toHaveBeenCalled();
    expect(resendSend).not.toHaveBeenCalled();
  });

  it('does not throw when an SMTP send fails, and counts it', async () => {
    verify.mockResolvedValue(true);
    sendMail.mockRejectedValue(Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' }));
    const svc = makeService({ ...BASE, 'mail.transport': 'smtp', 'mail.smtp.host': 'smtp.marina.test' });
    await svc.onModuleInit();
    await expect(svc.sendRawHtml('d@example.test', 'x', 'y')).resolves.toBeNull();
  });
});
