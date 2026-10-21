import {
  EmbedCallOptions,
  EmbedResult,
  EmbeddingProvider,
  EmbeddingProviderError,
  MAX_INPUT_CHARS,
} from './embedding-provider';
import { postJson } from './provider-http';

export const COHERE_DEFAULT_MODEL = 'embed-v4.0';
export const COHERE_DEFAULT_ENDPOINT = 'https://api.cohere.com';
/** embed-v4.0's default width; it also fits the existing vector(1536) stores. */
export const COHERE_DEFAULT_DIMENSIONS = 1536;

/** Texts per `/v2/embed` request (API limit is 96). */
const MAX_BATCH = 96;

interface CohereEmbedResponse {
  embeddings?: { float?: number[][] };
  meta?: { billed_units?: { input_tokens?: number } };
}

/**
 * Cohere embeddings over the v2 REST API with plain fetch. Queries and
 * documents are embedded with different `input_type`s, so the caller's intent
 * matters here.
 */
export class CohereEmbeddingProvider implements EmbeddingProvider {
  readonly id = 'cohere' as const;
  readonly endpoint: string;

  constructor(
    readonly model: string,
    private readonly apiKey: string,
    baseUrl?: string | null,
    private readonly dimensions?: number | null,
  ) {
    this.endpoint = (baseUrl || COHERE_DEFAULT_ENDPOINT).replace(/\/+$/, '');
  }

  async embed(texts: string[], opts?: EmbedCallOptions): Promise<EmbedResult> {
    const inputType = opts?.intent === 'query' ? 'search_query' : 'search_document';
    const vectors: number[][] = [];
    let tokens = 0;
    let sawTokens = false;

    for (let i = 0; i < texts.length; i += MAX_BATCH) {
      const slice = texts.slice(i, i + MAX_BATCH).map((t) => t.slice(0, MAX_INPUT_CHARS));
      const { body } = await postJson<CohereEmbedResponse>(
        'cohere',
        `${this.endpoint}/v2/embed`,
        {
          model: this.model,
          texts: slice,
          input_type: inputType,
          embedding_types: ['float'],
          ...(this.dimensions ? { output_dimension: this.dimensions } : {}),
        },
        { Authorization: `Bearer ${this.apiKey}` },
        opts?.signal,
      );

      const floats = body.embeddings?.float;
      if (!Array.isArray(floats) || floats.length !== slice.length) {
        throw new EmbeddingProviderError(
          'cohere',
          200,
          'unknown',
          `cohere returned ${floats?.length ?? 0} vector(s) for ${slice.length} input(s)`,
        );
      }
      vectors.push(...floats);
      const billed = body.meta?.billed_units?.input_tokens;
      if (typeof billed === 'number') {
        tokens += billed;
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
}
