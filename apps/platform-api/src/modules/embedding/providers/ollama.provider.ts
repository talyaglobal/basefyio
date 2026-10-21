import {
  EmbedCallOptions,
  EmbedResult,
  EmbeddingProvider,
  EmbeddingProviderError,
  MAX_INPUT_CHARS,
} from './embedding-provider';
import { postJson } from './provider-http';

export const OLLAMA_DEFAULT_MODEL = 'nomic-embed-text';
export const OLLAMA_DEFAULT_BASE_URL = 'http://localhost:11434';

/** Inputs per `/api/embed` request. */
const MAX_BATCH = 100;

interface OllamaEmbedResponse {
  embeddings?: number[][];
  prompt_eval_count?: number;
}

/**
 * The agent module reads the same `OLLAMA_BASE_URL` with an OpenAI-compatible
 * `/v1` suffix. The native embed endpoint lives at the root, so a trailing
 * `/v1` (and trailing slashes) are dropped here instead of asking operators to
 * keep two differently shaped URLs.
 */
export function normalizeOllamaBaseUrl(url: string): string {
  let base = url.trim().replace(/\/+$/, '');
  if (base.endsWith('/v1')) base = base.slice(0, -3);
  return base;
}

/** A self-hosted Ollama server, reached with plain fetch over `/api/embed`. */
export class OllamaEmbeddingProvider implements EmbeddingProvider {
  readonly id = 'ollama' as const;
  readonly endpoint: string;

  constructor(
    readonly model: string,
    baseUrl?: string | null,
    private readonly apiKey?: string | null,
  ) {
    this.endpoint = normalizeOllamaBaseUrl(baseUrl || OLLAMA_DEFAULT_BASE_URL);
  }

  async embed(texts: string[], opts?: EmbedCallOptions): Promise<EmbedResult> {
    const vectors: number[][] = [];
    let tokens = 0;
    let sawTokens = false;

    for (let i = 0; i < texts.length; i += MAX_BATCH) {
      const slice = texts.slice(i, i + MAX_BATCH).map((t) => t.slice(0, MAX_INPUT_CHARS));
      let body: OllamaEmbedResponse;
      try {
        ({ body } = await postJson<OllamaEmbedResponse>(
          'ollama',
          `${this.endpoint}/api/embed`,
          { model: this.model, input: slice, truncate: true },
          this.apiKey ? { Authorization: `Bearer ${this.apiKey}` } : {},
          opts?.signal,
        ));
      } catch (err) {
        throw this.decorate(err);
      }

      if (!Array.isArray(body.embeddings) || body.embeddings.length !== slice.length) {
        throw new EmbeddingProviderError(
          'ollama',
          200,
          'unknown',
          `ollama returned ${body.embeddings?.length ?? 0} vector(s) for ${slice.length} input(s)`,
        );
      }
      vectors.push(...body.embeddings);
      if (typeof body.prompt_eval_count === 'number') {
        tokens += body.prompt_eval_count;
        sawTokens = true;
      }
    }

    return {
      vectors,
      tokenCount: sawTokens ? tokens : null,
      model: this.model,
      dimensions: vectors[0]?.length ?? 0,
    };
  }

  /** A 404 from Ollama almost always means the model is not pulled on that host. */
  private decorate(err: unknown): unknown {
    if (
      err instanceof EmbeddingProviderError &&
      err.status === 404 &&
      /not found/i.test(err.message)
    ) {
      return new EmbeddingProviderError(
        'ollama',
        404,
        'input',
        `Model "${this.model}" is not available at ${this.endpoint} — run \`ollama pull ${this.model}\` on the embedding host.`,
      );
    }
    return err;
  }
}
