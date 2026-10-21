import OpenAI from 'openai';
import {
  EmbedCallOptions,
  EmbedResult,
  EmbeddingProvider,
  EmbeddingProviderError,
  MAX_INPUT_CHARS,
  kindForStatus,
} from './embedding-provider';

export const OPENAI_DEFAULT_MODEL = 'text-embedding-3-small';
export const OPENAI_DEFAULT_ENDPOINT = 'https://api.openai.com/v1';

/**
 * OpenAI embeddings through the existing `openai` client. With `baseUrl` set
 * the same adapter talks to any OpenAI-compatible endpoint (a gateway, an
 * Ollama `/v1` path, a private deployment).
 */
export class OpenAiEmbeddingProvider implements EmbeddingProvider {
  readonly id = 'openai' as const;
  readonly endpoint: string;
  private readonly client: OpenAI;

  constructor(
    readonly model: string,
    apiKey: string,
    baseUrl?: string | null,
    private readonly dimensions?: number | null,
  ) {
    this.endpoint = baseUrl?.replace(/\/+$/, '') || OPENAI_DEFAULT_ENDPOINT;
    this.client = new OpenAI({
      apiKey,
      ...(baseUrl ? { baseURL: this.endpoint } : {}),
    });
  }

  async embed(texts: string[], opts?: EmbedCallOptions): Promise<EmbedResult> {
    if (texts.length === 0) {
      return { vectors: [], tokenCount: 0, model: this.model, dimensions: 0 };
    }
    let response: OpenAI.Embeddings.CreateEmbeddingResponse;
    try {
      response = await this.client.embeddings.create(
        {
          model: this.model,
          input: texts.map((t) => t.slice(0, MAX_INPUT_CHARS)),
          ...(this.dimensions ? { dimensions: this.dimensions } : {}),
        },
        opts?.signal ? { signal: opts.signal } : undefined,
      );
    } catch (err) {
      throw toProviderError(err);
    }

    const vectors = [...response.data]
      .sort((a, b) => a.index - b.index)
      .map((d) => d.embedding);
    return {
      vectors,
      tokenCount: response.usage?.total_tokens ?? null,
      model: this.model,
      dimensions: vectors[0]?.length ?? 0,
    };
  }
}

function toProviderError(err: unknown): EmbeddingProviderError {
  if (err instanceof EmbeddingProviderError) return err;
  const status = err instanceof OpenAI.APIError ? err.status : undefined;
  const detail = err instanceof Error ? err.message : String(err);
  if (status === undefined) {
    return new EmbeddingProviderError('openai', undefined, 'unavailable', detail);
  }
  return new EmbeddingProviderError('openai', status, kindForStatus(status), detail);
}
