import {
  EmbedCallOptions,
  EmbedResult,
  EmbeddingProvider,
  EmbeddingProviderError,
  MAX_INPUT_CHARS,
} from './embedding-provider';
import { postJson } from './provider-http';

export const GEMINI_DEFAULT_MODEL = 'gemini-embedding-001';
export const GEMINI_DEFAULT_ENDPOINT = 'https://generativelanguage.googleapis.com/v1beta';
/**
 * gemini-embedding-001 returns 3072 dimensions unless asked for fewer, which
 * is wider than the vector(1536) stores. 1536 is one of the widths Google
 * recommends for the model, so it is requested unless another is configured.
 */
export const GEMINI_DEFAULT_DIMENSIONS = 1536;

/** Requests per `batchEmbedContents` call (API limit is 100). */
const MAX_BATCH = 100;

interface GeminiBatchResponse {
  embeddings?: Array<{ values?: number[] }>;
}

/**
 * Google Gemini embeddings over the Generative Language REST API with plain
 * fetch. Queries and documents use different task types, so the caller's
 * intent matters here, as it does for Cohere.
 */
export class GeminiEmbeddingProvider implements EmbeddingProvider {
  readonly id = 'gemini' as const;
  readonly endpoint: string;
  private readonly modelPath: string;
  private readonly outputDimensions: number | null;

  constructor(
    readonly model: string,
    private readonly apiKey: string,
    baseUrl?: string | null,
    dimensions?: number | null,
  ) {
    this.endpoint = (baseUrl || GEMINI_DEFAULT_ENDPOINT).replace(/\/+$/, '');
    // The API names models "models/<id>"; accept either spelling from config.
    const bare = model.replace(/^models\//, '');
    this.modelPath = `models/${bare}`;
    // Only the gemini-embedding family is known to accept 1536; any other model
    // gets its native width unless the operator configured one explicitly.
    this.outputDimensions =
      dimensions ?? (bare.startsWith('gemini-embedding') ? GEMINI_DEFAULT_DIMENSIONS : null);
  }

  async embed(texts: string[], opts?: EmbedCallOptions): Promise<EmbedResult> {
    const taskType = opts?.intent === 'query' ? 'RETRIEVAL_QUERY' : 'RETRIEVAL_DOCUMENT';
    const vectors: number[][] = [];

    for (let i = 0; i < texts.length; i += MAX_BATCH) {
      const slice = texts.slice(i, i + MAX_BATCH).map((t) => t.slice(0, MAX_INPUT_CHARS));
      let body: GeminiBatchResponse;
      try {
        ({ body } = await postJson<GeminiBatchResponse>(
          'gemini',
          `${this.endpoint}/${this.modelPath}:batchEmbedContents`,
          {
            requests: slice.map((text) => ({
              model: this.modelPath,
              content: { parts: [{ text }] },
              taskType,
              ...(this.outputDimensions ? { outputDimensionality: this.outputDimensions } : {}),
            })),
          },
          { 'x-goog-api-key': this.apiKey },
          opts?.signal,
        ));
      } catch (err) {
        throw reclassify(err);
      }

      const values = body.embeddings?.map((e) => e.values);
      if (
        !Array.isArray(values) ||
        values.length !== slice.length ||
        values.some((v) => !Array.isArray(v) || v.length === 0)
      ) {
        throw new EmbeddingProviderError(
          'gemini',
          200,
          'unknown',
          `gemini returned ${values?.length ?? 0} vector(s) for ${slice.length} input(s)`,
        );
      }
      // Below the native 3072 dimensions the vectors are not unit length;
      // Google recommends normalizing them. Cosine distance is unaffected,
      // inner-product search is not, so they are stored normalized.
      vectors.push(...(values as number[][]).map(normalize));
    }

    return {
      vectors,
      // The batch endpoint does not report token usage.
      tokenCount: null,
      model: this.model,
      dimensions: vectors[0]?.length ?? 0,
    };
  }
}

/**
 * Google answers an invalid API key with HTTP 400 (INVALID_ARGUMENT,
 * reason API_KEY_INVALID) rather than 401, which would otherwise read as a bad
 * request instead of a rejected key — and a rejected key must fail over and
 * must be reported as a key problem.
 */
function reclassify(err: unknown): unknown {
  if (
    err instanceof EmbeddingProviderError &&
    err.status === 400 &&
    /api key not valid|api_key_invalid|api key expired/i.test(err.message)
  ) {
    return new EmbeddingProviderError('gemini', 400, 'auth', err.message);
  }
  return err;
}

function normalize(v: number[]): number[] {
  let sum = 0;
  for (const x of v) sum += x * x;
  const norm = Math.sqrt(sum);
  if (!norm || Math.abs(norm - 1) < 1e-6) return v;
  return v.map((x) => x / norm);
}
