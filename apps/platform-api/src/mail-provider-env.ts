/**
 * Point the mail SDK at the right provider before it is imported.
 *
 * The Resend SDK resolves its API base once, at module load, from
 * process.env.RESEND_BASE_URL — the constructor takes only a key. So a
 * tsmartSend key with no base URL set would be sent to api.resend.com and
 * refused, with nothing in the configuration able to correct it afterwards.
 *
 * Deriving the base from the key's own prefix means an operator sets one
 * variable instead of two and cannot get the pair wrong. An explicit
 * RESEND_BASE_URL still wins, so a self-hosted install can point the mailer
 * anywhere that speaks the same contract.
 *
 * This file has to be imported before anything that imports 'resend', which
 * is why it is the first import in main.ts rather than part of the config
 * module — Nest loads configuration well after the first require of the SDK.
 */
const TSMART_SEND_BASE_URL = 'https://send.tsmart.ai';

export function resolveMailBaseUrl(env: NodeJS.ProcessEnv = process.env): string | undefined {
  if (env.RESEND_BASE_URL) return env.RESEND_BASE_URL;
  const key = env.TSMART_SEND_API_KEY || env.RESEND_API_KEY || '';
  if (env.TSMART_SEND_API_KEY || key.startsWith('ts_')) return TSMART_SEND_BASE_URL;
  return undefined;
}

const resolved = resolveMailBaseUrl();
if (resolved && !process.env.RESEND_BASE_URL) {
  process.env.RESEND_BASE_URL = resolved;
}
