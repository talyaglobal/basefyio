import Anthropic from '@anthropic-ai/sdk';
import OpenAI from 'openai';

/**
 * The language models the dashboard assistant can talk to.
 *
 * The platform runs the assistant on its own OpenAI key. A project can bring
 * its own key for OpenAI, Google Gemini or Anthropic Claude instead; the
 * assistant then uses that key whenever the conversation is about that
 * project. Everything above this file speaks one small interface — a system
 * prompt plus turns in, text out (streamed or whole) — so the provider is a
 * configuration detail.
 */

export type AiProviderId = 'openai' | 'gemini' | 'anthropic';

export const AI_PROVIDER_IDS: readonly AiProviderId[] = ['openai', 'gemini', 'anthropic'];

export function isAiProviderId(value: unknown): value is AiProviderId {
  return typeof value === 'string' && (AI_PROVIDER_IDS as readonly string[]).includes(value);
}

export interface AiProviderInfo {
  id: AiProviderId;
  name: string;
  defaultModel: string;
  /** Suggestions for the model field; any model id the provider serves is accepted. */
  models: string[];
  keyPlaceholder: string;
  keyHelpUrl: string;
}

/**
 * Model suggestions. The field is free text and a key is tested against the
 * chosen model before it is saved, so a retired id is caught at save time.
 */
export const AI_PROVIDERS: Record<AiProviderId, AiProviderInfo> = {
  openai: {
    id: 'openai',
    name: 'OpenAI',
    defaultModel: 'gpt-4o-mini',
    models: ['gpt-4o-mini', 'gpt-4.1-mini', 'gpt-4.1', 'gpt-5-mini', 'gpt-5'],
    keyPlaceholder: 'sk-...',
    keyHelpUrl: 'https://platform.openai.com/api-keys',
  },
  gemini: {
    id: 'gemini',
    name: 'Google Gemini',
    defaultModel: 'gemini-2.5-flash',
    models: ['gemini-2.5-flash', 'gemini-2.5-pro', 'gemini-2.5-flash-lite'],
    keyPlaceholder: 'AIza...',
    keyHelpUrl: 'https://aistudio.google.com/apikey',
  },
  anthropic: {
    id: 'anthropic',
    name: 'Anthropic Claude',
    defaultModel: 'claude-opus-5-5',
    models: ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5'],
    keyPlaceholder: 'sk-ant-...',
    keyHelpUrl: 'https://console.anthropic.com/settings/keys',
  },
};

/** Gemini's OpenAI-compatible endpoint, so the OpenAI SDK can drive it. */
export const GEMINI_OPENAI_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta/openai/';

export interface LlmTurn {
  role: 'user' | 'assistant';
  content: string;
}

export interface LlmRequest {
  system: string;
  turns: LlmTurn[];
  maxTokens: number;
  /** Ignored by models that do not accept it (Claude 5, OpenAI reasoning models). */
  temperature?: number;
  signal?: AbortSignal;
}

export interface LlmClient {
  readonly provider: AiProviderId;
  readonly model: string;
  /** Text deltas as the model produces them. */
  stream(req: LlmRequest): AsyncIterable<string>;
  /** The whole reply at once. */
  complete(req: LlmRequest): Promise<string>;
}

export interface LlmConfig {
  provider: AiProviderId;
  model: string;
  apiKey: string;
}

/** A provider refused or failed; `kind` decides how the error is shown. */
export class LlmError extends Error {
  constructor(
    readonly kind: 'auth' | 'quota' | 'input' | 'unavailable' | 'refusal' | 'aborted',
    message: string,
  ) {
    super(message);
    this.name = 'LlmError';
  }
}

export function createLlmClient(cfg: LlmConfig): LlmClient {
  switch (cfg.provider) {
    case 'anthropic':
      return new AnthropicLlm(cfg.model, cfg.apiKey);
    case 'gemini':
      return new OpenAiCompatibleLlm('gemini', cfg.model, cfg.apiKey, GEMINI_OPENAI_BASE_URL);
    case 'openai':
    default:
      return new OpenAiCompatibleLlm('openai', cfg.model, cfg.apiKey);
  }
}

/** Reasoning models (o-series, gpt-5) reject a temperature other than the default. */
function acceptsTemperature(provider: AiProviderId, model: string): boolean {
  if (provider === 'gemini') return true;
  return /^(gpt-4|gpt-3\.5|chatgpt-)/i.test(model);
}

function classifyHttpError(err: any, providerName: string): LlmError {
  if (err?.name === 'AbortError' || err?.name === 'APIUserAbortError') {
    return new LlmError('aborted', 'The request was stopped.');
  }
  const status: number | undefined = err?.status ?? err?.response?.status;
  const raw = String(err?.error?.error?.message ?? err?.error?.message ?? err?.message ?? err);
  const detail = raw.replace(/\s+/g, ' ').slice(0, 300);
  if (status === 401 || status === 403 || /api key not valid|api_key_invalid|invalid x-api-key|incorrect api key/i.test(raw)) {
    return new LlmError('auth', `${providerName} rejected the API key (${detail}).`);
  }
  if (status === 429) return new LlmError('quota', `${providerName} rate limit or quota reached (${detail}).`);
  if (status === 400 || status === 404 || status === 422) {
    return new LlmError('input', `${providerName} refused the request (${detail}).`);
  }
  return new LlmError('unavailable', `${providerName} could not be reached (${detail}).`);
}

class OpenAiCompatibleLlm implements LlmClient {
  private readonly client: OpenAI;

  constructor(
    readonly provider: 'openai' | 'gemini',
    readonly model: string,
    apiKey: string,
    baseURL?: string,
  ) {
    this.client = new OpenAI({ apiKey, ...(baseURL ? { baseURL } : {}), maxRetries: 1 });
  }

  private params(req: LlmRequest) {
    const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [
      { role: 'system', content: req.system },
      ...req.turns.map((t) => ({ role: t.role, content: t.content })),
    ];
    return {
      model: this.model,
      messages,
      // Gemini's compatibility layer documents max_tokens; OpenAI's newer models
      // only accept max_completion_tokens, which every current chat model takes.
      ...(this.provider === 'gemini'
        ? { max_tokens: req.maxTokens }
        : { max_completion_tokens: req.maxTokens }),
      ...(req.temperature !== undefined && acceptsTemperature(this.provider, this.model)
        ? { temperature: req.temperature }
        : {}),
    };
  }

  async *stream(req: LlmRequest): AsyncIterable<string> {
    let stream: AsyncIterable<OpenAI.Chat.ChatCompletionChunk>;
    try {
      stream = await this.client.chat.completions.create(
        { ...this.params(req), stream: true },
        { signal: req.signal },
      );
    } catch (err) {
      throw classifyHttpError(err, AI_PROVIDERS[this.provider].name);
    }
    try {
      for await (const chunk of stream) {
        const text = chunk.choices?.[0]?.delta?.content;
        if (text) yield text;
      }
    } catch (err) {
      throw classifyHttpError(err, AI_PROVIDERS[this.provider].name);
    }
  }

  async complete(req: LlmRequest): Promise<string> {
    try {
      const res = await this.client.chat.completions.create(this.params(req), { signal: req.signal });
      return res.choices?.[0]?.message?.content ?? '';
    } catch (err) {
      throw classifyHttpError(err, AI_PROVIDERS[this.provider].name);
    }
  }
}

class AnthropicLlm implements LlmClient {
  readonly provider = 'anthropic' as const;
  private readonly client: Anthropic;

  constructor(
    readonly model: string,
    apiKey: string,
  ) {
    this.client = new Anthropic({ apiKey, maxRetries: 1 });
  }

  /**
   * Claude 5 models think adaptively and reject sampling parameters, so no
   * temperature is sent. Effort is set explicitly: the default differs by
   * model, and an assistant answering in a side panel wants a steady middle.
   */
  private params(req: LlmRequest): Anthropic.MessageCreateParamsNonStreaming {
    return {
      model: this.model,
      max_tokens: req.maxTokens,
      system: req.system,
      messages: req.turns.map((t) => ({ role: t.role, content: t.content })),
      ...(/^claude-(opus|sonnet|haiku|fable)-5/.test(this.model)
        ? { output_config: { effort: 'medium' } }
        : {}),
    } as Anthropic.MessageCreateParamsNonStreaming;
  }

  async *stream(req: LlmRequest): AsyncIterable<string> {
    const stream = this.client.messages.stream(this.params(req), { signal: req.signal });
    try {
      for await (const event of stream) {
        if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
          yield event.delta.text;
        }
      }
      const final = await stream.finalMessage();
      if (final.stop_reason === 'refusal') {
        throw new LlmError('refusal', 'Claude declined to answer this request.');
      }
    } catch (err) {
      if (err instanceof LlmError) throw err;
      throw classifyHttpError(err, AI_PROVIDERS.anthropic.name);
    }
  }

  async complete(req: LlmRequest): Promise<string> {
    try {
      const res = await this.client.messages.create(this.params(req), { signal: req.signal });
      if (res.stop_reason === 'refusal') {
        throw new LlmError('refusal', 'Claude declined to answer this request.');
      }
      return res.content
        .filter((b): b is Anthropic.TextBlock => b.type === 'text')
        .map((b) => b.text)
        .join('');
    } catch (err) {
      if (err instanceof LlmError) throw err;
      throw classifyHttpError(err, AI_PROVIDERS.anthropic.name);
    }
  }
}
