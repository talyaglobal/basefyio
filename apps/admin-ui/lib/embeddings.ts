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

export interface SetEmbeddingProviderResult {
  provider: string;
  model: string;
  dimensions: number;
  storedDimensions: number | null;
  padded: boolean;
  reembed: { queued: boolean; total: number };
}
