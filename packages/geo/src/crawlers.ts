/**
 * Registry of the AI / generative-engine crawlers worth an explicit policy.
 *
 * "Generative Engine Optimization" only works if these user-agents can reach
 * your content. Blocking a `search` crawler removes you from that engine's
 * answers; blocking a `training` crawler keeps you out of the next model but
 * leaves live answers intact. The audit and robots generators read this list.
 *
 * Tokens are the literal `User-agent` strings the vendors publish. Keep in sync
 * with vendor docs — they change occasionally.
 */
import type { AiCrawler } from './types.js';

export const AI_CRAWLERS: AiCrawler[] = [
  // ── OpenAI ────────────────────────────────────────────
  {
    token: 'GPTBot',
    operator: 'OpenAI',
    label: 'OpenAI model training',
    purpose: 'training',
    docs: 'https://platform.openai.com/docs/gptbot',
  },
  {
    token: 'OAI-SearchBot',
    operator: 'OpenAI',
    label: 'ChatGPT search index',
    purpose: 'search',
    docs: 'https://platform.openai.com/docs/bots',
  },
  {
    token: 'ChatGPT-User',
    operator: 'OpenAI',
    label: 'ChatGPT live browsing',
    purpose: 'user-action',
    docs: 'https://platform.openai.com/docs/bots',
  },

  // ── Anthropic ─────────────────────────────────────────
  {
    token: 'ClaudeBot',
    operator: 'Anthropic',
    label: 'Claude crawler',
    purpose: 'training',
    docs: 'https://support.anthropic.com/en/articles/8896518',
  },
  {
    token: 'Claude-SearchBot',
    operator: 'Anthropic',
    label: 'Claude search index',
    purpose: 'search',
    docs: 'https://support.anthropic.com/en/articles/8896518',
  },
  {
    token: 'Claude-User',
    operator: 'Anthropic',
    label: 'Claude live browsing',
    purpose: 'user-action',
    docs: 'https://support.anthropic.com/en/articles/8896518',
  },

  // ── Google ────────────────────────────────────────────
  {
    token: 'Google-Extended',
    operator: 'Google',
    label: 'Gemini training / grounding',
    purpose: 'training',
    docs: 'https://developers.google.com/search/docs/crawling-indexing/overview-google-crawlers',
  },

  // ── Perplexity ────────────────────────────────────────
  {
    token: 'PerplexityBot',
    operator: 'Perplexity',
    label: 'Perplexity search index',
    purpose: 'search',
    docs: 'https://docs.perplexity.ai/guides/bots',
  },
  {
    token: 'Perplexity-User',
    operator: 'Perplexity',
    label: 'Perplexity live fetch',
    purpose: 'user-action',
    docs: 'https://docs.perplexity.ai/guides/bots',
  },

  // ── Apple ─────────────────────────────────────────────
  {
    token: 'Applebot-Extended',
    operator: 'Apple',
    label: 'Apple Intelligence training',
    purpose: 'training',
    docs: 'https://support.apple.com/en-us/119829',
  },

  // ── Microsoft ─────────────────────────────────────────
  {
    token: 'Bingbot',
    operator: 'Microsoft',
    label: 'Bing / Copilot index',
    purpose: 'search',
    docs: 'https://www.bing.com/webmasters/help/which-crawlers-does-bing-use-8c184ec0',
  },

  // ── Common Crawl (feeds many open models) ─────────────
  {
    token: 'CCBot',
    operator: 'Common Crawl',
    label: 'Common Crawl (open datasets)',
    purpose: 'training',
    docs: 'https://commoncrawl.org/ccbot',
  },

  // ── Meta ──────────────────────────────────────────────
  {
    token: 'meta-externalagent',
    operator: 'Meta',
    label: 'Meta AI training',
    purpose: 'training',
    docs: 'https://developers.facebook.com/docs/sharing/webmasters/web-crawlers',
  },

  // ── Amazon ────────────────────────────────────────────
  {
    token: 'Amazonbot',
    operator: 'Amazon',
    label: 'Amazon (Alexa / Rufus)',
    purpose: 'search',
    docs: 'https://developer.amazon.com/amazonbot',
  },
];

/** Look up a crawler by its `User-agent` token (case-insensitive). */
export function findCrawler(token: string): AiCrawler | undefined {
  const t = token.toLowerCase();
  return AI_CRAWLERS.find((c) => c.token.toLowerCase() === t);
}

/** Crawlers filtered by purpose. */
export function crawlersByPurpose(
  ...purposes: AiCrawler['purpose'][]
): AiCrawler[] {
  return AI_CRAWLERS.filter((c) => purposes.includes(c.purpose));
}
