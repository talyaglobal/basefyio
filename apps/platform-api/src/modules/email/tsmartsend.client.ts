import { randomUUID } from 'crypto';

/** Where tsmartsend's Resend-shaped sending API lives; override with TSMART_SEND_BASE_URL. */
export const TSMARTSEND_DEFAULT_BASE_URL = 'https://send.tsmart.ai';

/** The page a user opens to create their tsmartsend project (confirm with the product owner). */
export const TSMARTSEND_SIGNUP_URL = 'https://send.tsmart.ai';

export interface TsmartsendMail {
  apiKey: string;
  from: string;
  to: string;
  subject: string;
  html?: string | null;
  text?: string | null;
  replyTo?: string | null;
  /** Same key on a retry of the same mail makes tsmartsend send it once. */
  idempotencyKey?: string;
}

export class TsmartsendError extends Error {
  constructor(
    message: string,
    readonly status: number,
    /** 401/403 mean the key or the sender domain is wrong: retrying cannot help. */
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = 'TsmartsendError';
  }
}

/** Sends one mail through tsmartsend (`POST {base}/emails`, Bearer key). Throws TsmartsendError on any failure. */
export async function sendViaTsmartsend(mail: TsmartsendMail): Promise<{ id?: string }> {
  const base = (process.env.TSMART_SEND_BASE_URL?.trim() || TSMARTSEND_DEFAULT_BASE_URL).replace(/\/+$/, '');
  const body: Record<string, unknown> = {
    from: mail.from,
    to: [mail.to],
    subject: mail.subject,
  };
  if (mail.html) body.html = mail.html;
  if (mail.text) body.text = mail.text;
  if (mail.replyTo) body.reply_to = mail.replyTo;

  let res: Response;
  try {
    res = await fetch(`${base}/emails`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${mail.apiKey}`,
        'content-type': 'application/json',
        'idempotency-key': mail.idempotencyKey ?? randomUUID(),
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10_000),
    });
  } catch (err) {
    throw new TsmartsendError(`tsmartsend unreachable: ${(err as Error).message}`, 0, true);
  }

  if (res.ok) {
    const json = (await res.json().catch(() => ({}))) as { id?: string };
    return { id: json.id };
  }
  const detail = (await res.json().catch(() => null)) as { message?: string; name?: string } | null;
  const message = `tsmartsend ${res.status}${detail?.name ? ` ${detail.name}` : ''}: ${detail?.message ?? res.statusText}`;
  throw new TsmartsendError(message, res.status, res.status === 429 || res.status >= 500);
}
