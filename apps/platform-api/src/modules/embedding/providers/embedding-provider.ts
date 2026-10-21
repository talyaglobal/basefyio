/**
 * Embedding provider contract.
 *
 * Every provider turns a list of texts into one vector per text. The platform
 * store (`embeddings_store`) and the per-project stores (`kb_embeddings_store`)
 * are pgvector columns with a fixed width, so the caller — not the provider —
 * decides how a vector of another width is fitted (see
 * `EmbeddingProviderService.fitDimensions`).
 */

export type EmbeddingProviderId = 'openai' | 'ollama' | 'cohere';

export const EMBEDDING_PROVIDER_IDS: readonly EmbeddingProviderId[] = [
  'openai',
  'ollama',
  'cohere',
];

export function isEmbeddingProviderId(value: unknown): value is EmbeddingProviderId {
  return (
    typeof value === 'string' &&
    (EMBEDDING_PROVIDER_IDS as readonly string[]).includes(value)
  );
}

/**
 * Some providers embed search queries and stored documents differently
 * (Cohere's `input_type`). Providers that do not distinguish ignore it.
 */
export type EmbedIntent = 'document' | 'query';

export interface EmbedResult {
  /** One vector per input text, in input order. */
  vectors: number[][];
  /** Tokens billed for the whole request, when the provider reports them. */
  tokenCount: number | null;
  model: string;
  /** Width of the returned vectors (0 when no text was embedded). */
  dimensions: number;
}

export interface EmbedCallOptions {
  intent?: EmbedIntent;
  signal?: AbortSignal;
}

export interface EmbeddingProvider {
  readonly id: EmbeddingProviderId;
  readonly model: string;
  /** Base URL actually used — reported in the data disclosure. */
  readonly endpoint: string;
  embed(texts: string[], opts?: EmbedCallOptions): Promise<EmbedResult>;
}

/**
 * How a provider failure should be treated:
 *  - auth: the key was rejected (401/403)
 *  - quota: rate limit or quota (429)
 *  - input: the request itself is wrong (400/422, unknown model) — never fail over
 *  - unavailable: no HTTP response at all (DNS, connection, timeout)
 *  - unknown: an HTTP error that fits none of the above (5xx mostly)
 */
export type ProviderErrorKind = 'auth' | 'quota' | 'input' | 'unavailable' | 'unknown';

export class EmbeddingProviderError extends Error {
  constructor(
    readonly provider: EmbeddingProviderId,
    readonly status: number | undefined,
    readonly kind: ProviderErrorKind,
    message: string,
  ) {
    super(message);
    this.name = 'EmbeddingProviderError';
  }
}

export interface EmbeddingProviderConfig {
  provider: EmbeddingProviderId;
  model?: string | null;
  baseUrl?: string | null;
  apiKey?: string | null;
  /** Request-side output width for models that support it (OpenAI v3, Cohere v4). */
  dimensions?: number | null;
}

/** Inputs are cut here before they are sent, as the OpenAI path always did. */
export const MAX_INPUT_CHARS = 8000;

/** Per-request network timeout for plain-fetch providers. */
export const REQUEST_TIMEOUT_MS = 30_000;

/** Map an HTTP status to the failure kind used for error messages and failover. */
export function kindForStatus(status: number): ProviderErrorKind {
  if (status === 401 || status === 403) return 'auth';
  if (status === 429) return 'quota';
  if (status === 400 || status === 404 || status === 422) return 'input';
  return 'unknown';
}
