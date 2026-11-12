/** Response shapes of the embeddings routes (see TenantEmbeddingService). */

export interface DataRegion {
  /** ISO 3166-1 alpha-2 code where known; null when not specified. */
  code: string | null;
  label: string;
}

export interface ReembedState {
  status: 'QUEUED' | 'RUNNING' | 'COMPLETED' | 'FAILED';
  done: number;
  total: number;
  model: string;
  startedAt?: string;
  updatedAt: string;
  finishedAt?: string;
  error?: string;
}

export interface EmbeddingStatus {
  pgvectorEnabled: boolean;
  pgvectorEnabledAt: string | null;
  hasApiKey: boolean;
  embeddingCount: number | null;
  provider: string;
  providerName: string;
  model: string;
  modelTag: string;
  configSource: 'project' | 'platform';
  keySource: 'project' | 'platform' | 'none';
  requiresApiKey: boolean;
  /** The project's custom endpoint, when one is set. */
  baseUrl: string | null;
  dimensions: number | null;
  storedDimensions: number | null;
  padded: boolean;
  dataRegion: DataRegion;
  reembed: ReembedState | null;
}

export interface EmbeddingProviderOption {
  id: string;
  name: string;
  defaultModel: string;
  requiresApiKey: boolean;
  keyEnvVar: string | null;
  supportsBaseUrl: boolean;
  platformKeyAvailable: boolean;
  selfHosted: boolean;
  dataRegion: DataRegion;
}

export interface EmbeddingProviderCatalogue {
  platformProvider: string;
  platformModel: string;
  hostRegion: DataRegion;
  allowPrivateBaseUrl: boolean;
  reembedMaxRows: number;
  providers: EmbeddingProviderOption[];
}

export interface EmbeddingDisclosure {
  scope: 'project' | 'platform';
  configSource: 'project' | 'platform';
  status: 'ok' | 'no_api_key' | 'misconfigured';
  statusMessage: string | null;
  provider: {
    id: string;
    name: string;
    model: string;
    modelTag: string;
    endpointHost: string;
    dimensions: number | null;
    storedDimensions: number | null;
    padded: boolean;
    keySource: 'project' | 'platform' | 'none';
    requiresApiKey: boolean;
    selfHosted: boolean;
  };
  dataRegion: DataRegion;
  processing: {
    sentToProvider: string[];
    usedForTraining: boolean;
    retention: string;
    policyUrl: string | null;
  };
  storage: { engine: string; region: DataRegion };
  fallback: {
    id: string;
    name: string;
    model: string;
    dataRegion: DataRegion;
    vectorSpaceDiffers: boolean;
  } | null;
  generatedAt: string;
}

export interface SetEmbeddingProviderBody {
  provider: string | null;
  model?: string | null;
  baseUrl?: string | null;
  reembed?: boolean;
}

/** Extra fields of POST /embeddings/api-key. */
export interface SetEmbeddingApiKeyOptions {
  /**
   * The provider the key is for when it is not the saved one (the provider
   * picked in the form); null = the platform default. Omit for the saved one.
   */
  provider?: string | null;
  model?: string | null;
  baseUrl?: string | null;
  /** Store without the test request (only after an "unreachable" / "test failed" answer). */
  skipValidation?: boolean;
}

export interface SetEmbeddingApiKeyResult {
  message: string;
  /** A test request with the key succeeded (false when cleared or stored unverified). */
  verified?: boolean;
  /** Set when the key authenticated but the provider reported a rate limit or quota. */
  warning?: string | null;
}

/**
 * Tables the platform creates in a project database when pgvector is enabled.
 * They are reached through the Embeddings API, so lists meant for the
 * project's own tables (the REST explorer) leave them out.
 */
export const PLATFORM_EMBEDDING_TABLES: readonly string[] = ['kb_embeddings', 'kb_embeddings_store'];

export function isPlatformEmbeddingTable(name: string, schema?: string | null): boolean {
  return (schema == null || schema === 'public') && PLATFORM_EMBEDDING_TABLES.includes(name);
}

export interface SetEmbeddingProviderResult {
  provider: string;
  model: string;
  dimensions: number;
  storedDimensions: number | null;
  padded: boolean;
  reembed: { queued: boolean; total: number };
}
