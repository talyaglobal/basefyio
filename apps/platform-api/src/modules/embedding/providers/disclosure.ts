import { EmbeddingProviderConfig, EmbeddingProviderId } from './embedding-provider';
import { PROVIDER_CATALOGUE, endpointFor, modelTag } from './provider-registry';
import { hostOf } from './provider-http';

export interface DataRegion {
  /** ISO 3166-1 alpha-2 code where known; null when the operator has not set one. */
  code: string | null;
  label: string;
}

export type KeySource = 'project' | 'platform' | 'none';
export type ConfigSource = 'project' | 'platform';
export type DisclosureStatus = 'ok' | 'no_api_key' | 'misconfigured';

/**
 * What a customer (and, through the public route, their end users) can see
 * about where embedded text goes. Never carries a key or a URL with credentials.
 */
export interface ProviderDisclosure {
  scope: 'project' | 'platform';
  configSource: ConfigSource;
  status: DisclosureStatus;
  statusMessage: string | null;
  provider: {
    id: EmbeddingProviderId;
    name: string;
    model: string;
    /** `embedding_records.embedding_model` value for this configuration. */
    modelTag: string;
    /** Host of the endpoint in use (no path, no credentials). */
    endpointHost: string;
    /** Native width of the model's vectors; null when it could not be determined. */
    dimensions: number | null;
    /** Width of the pgvector column the vectors are written to; null when the store is not provisioned. */
    storedDimensions: number | null;
    /** True when vectors are zero-padded up to the column width. */
    padded: boolean;
    keySource: KeySource;
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
  storage: {
    engine: string;
    region: DataRegion;
  };
  fallback: {
    id: EmbeddingProviderId;
    name: string;
    model: string;
    dataRegion: DataRegion;
    /** The fallback produces vectors in another space; relevance drops while it is in use. */
    vectorSpaceDiffers: boolean;
  } | null;
  generatedAt: string;
}

const REGION_LABELS: Record<string, string> = {
  US: 'United States',
  DE: 'Germany',
  FI: 'Finland',
  NL: 'Netherlands',
  FR: 'France',
  GB: 'United Kingdom',
  IE: 'Ireland',
  TR: 'Türkiye',
  CA: 'Canada',
  SG: 'Singapore',
  AU: 'Australia',
  JP: 'Japan',
  IN: 'India',
  BR: 'Brazil',
  CH: 'Switzerland',
  SE: 'Sweden',
  NO: 'Norway',
  PL: 'Poland',
  ES: 'Spain',
  IT: 'Italy',
};

export const REGION_NOT_SPECIFIED: DataRegion = { code: null, label: 'not specified' };

/** Operator-supplied region code → disclosure region. Never guesses: empty stays "not specified". */
export function regionFromCode(code: string | null | undefined): DataRegion {
  const c = (code ?? '').trim().toUpperCase();
  if (!c) return REGION_NOT_SPECIFIED;
  return { code: c, label: REGION_LABELS[c] ?? c };
}

export interface BuildDisclosureInput {
  scope: 'project' | 'platform';
  configSource: ConfigSource;
  config: EmbeddingProviderConfig;
  keySource: KeySource;
  fallback: EmbeddingProviderConfig | null;
  /** Native width when known (probe result), else null. */
  dimensions: number | null;
  storedDimensions: number | null;
  hostRegion: string;
  /** Whether the configured endpoint is the platform's own Ollama host. */
  endpointIsPlatformHost: boolean;
  status?: DisclosureStatus;
  statusMessage?: string | null;
}

export function buildDisclosure(input: BuildDisclosureInput): ProviderDisclosure {
  const entry = PROVIDER_CATALOGUE[input.config.provider];
  const model = input.config.model?.trim() || entry.defaultModel;
  const endpoint = endpointFor(input.config);
  const storageRegion = regionFromCode(input.hostRegion);

  let dataRegion: DataRegion;
  if (entry.disclosure.selfHosted) {
    dataRegion = input.endpointIsPlatformHost
      ? { ...storageRegion, label: `Self-hosted on this server (${storageRegion.label})` }
      : { code: null, label: `Self-hosted at ${hostOf(endpoint)} (customer endpoint)` };
  } else {
    dataRegion = { ...entry.disclosure.dataRegion };
  }

  const padded =
    input.dimensions != null &&
    input.storedDimensions != null &&
    input.dimensions < input.storedDimensions;

  let fallback: ProviderDisclosure['fallback'] = null;
  if (input.fallback) {
    const fb = PROVIDER_CATALOGUE[input.fallback.provider];
    const fbModel = input.fallback.model?.trim() || fb.defaultModel;
    fallback = {
      id: fb.id,
      name: fb.name,
      model: fbModel,
      dataRegion: fb.disclosure.selfHosted
        ? { ...storageRegion, label: `Self-hosted (${storageRegion.label})` }
        : { ...fb.disclosure.dataRegion },
      vectorSpaceDiffers:
        modelTag(fb.id, fbModel) !== modelTag(input.config.provider, model),
    };
  }

  return {
    scope: input.scope,
    configSource: input.configSource,
    status: input.status ?? 'ok',
    statusMessage: input.statusMessage ?? null,
    provider: {
      id: entry.id,
      name: entry.name,
      model,
      modelTag: modelTag(entry.id, model),
      endpointHost: hostOf(endpoint),
      dimensions: input.dimensions,
      storedDimensions: input.storedDimensions,
      padded,
      keySource: input.keySource,
      requiresApiKey: entry.requiresApiKey,
      selfHosted: entry.disclosure.selfHosted,
    },
    dataRegion,
    processing: {
      sentToProvider: ['document text when it is stored or indexed', 'search queries'],
      usedForTraining: entry.disclosure.usedForTraining,
      retention: entry.disclosure.retention,
      policyUrl: entry.disclosure.policyUrl,
    },
    storage: {
      engine:
        input.scope === 'project'
          ? 'PostgreSQL + pgvector in the project database'
          : 'PostgreSQL + pgvector in the platform database',
      region: storageRegion,
    },
    fallback,
    generatedAt: new Date().toISOString(),
  };
}
