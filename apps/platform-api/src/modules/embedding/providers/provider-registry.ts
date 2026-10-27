import { aiEnabled, AI_DISABLED_MESSAGE } from '../../../common/utils/ai-switch';
import {
  EMBEDDING_PROVIDER_IDS,
  EmbeddingProvider,
  EmbeddingProviderConfig,
  EmbeddingProviderError,
  EmbeddingProviderId,
  isEmbeddingProviderId,
} from './embedding-provider';
import {
  OPENAI_DEFAULT_ENDPOINT,
  OPENAI_DEFAULT_MODEL,
  OpenAiEmbeddingProvider,
} from './openai.provider';
import {
  OLLAMA_DEFAULT_BASE_URL,
  OLLAMA_DEFAULT_MODEL,
  OllamaEmbeddingProvider,
  normalizeOllamaBaseUrl,
} from './ollama.provider';
import {
  COHERE_DEFAULT_ENDPOINT,
  COHERE_DEFAULT_MODEL,
  CohereEmbeddingProvider,
} from './cohere.provider';

export interface ProviderDisclosureText {
  /** Where the provider processes the text. `SELF_HOSTED` is replaced by the host region at runtime. */
  dataRegion: { code: string; label: string };
  retention: string;
  policyUrl: string | null;
  usedForTraining: boolean;
  selfHosted: boolean;
}

export interface ProviderCatalogueEntry {
  id: EmbeddingProviderId;
  name: string;
  defaultModel: string;
  defaultEndpoint: string;
  requiresApiKey: boolean;
  /** Env var that carries the platform-level key, for error messages. */
  keyEnvVar: string | null;
  supportsBaseUrl: boolean;
  /** Embeds queries and documents differently. */
  intentSensitive: boolean;
  disclosure: ProviderDisclosureText;
}

/**
 * Disclosure text shown to customers. Short and factual by design.
 *
 * RE-VERIFY BEFORE EACH RELEASE: these statements and URLs summarise each
 * provider's published API data-usage terms at the time of writing. The owner
 * signs off on the wording; when a provider changes its terms, change it here.
 */
export const PROVIDER_CATALOGUE: Record<EmbeddingProviderId, ProviderCatalogueEntry> = {
  openai: {
    id: 'openai',
    name: 'OpenAI',
    defaultModel: OPENAI_DEFAULT_MODEL,
    defaultEndpoint: OPENAI_DEFAULT_ENDPOINT,
    requiresApiKey: true,
    keyEnvVar: 'OPENAI_API_KEY',
    supportsBaseUrl: true,
    intentSensitive: false,
    disclosure: {
      dataRegion: { code: 'US', label: 'United States' },
      retention:
        'Text sent to the OpenAI API is not used to train OpenAI models. OpenAI may keep API inputs for up to 30 days for abuse monitoring, then deletes them.',
      policyUrl: 'https://openai.com/enterprise-privacy',
      usedForTraining: false,
      selfHosted: false,
    },
  },
  ollama: {
    id: 'ollama',
    name: 'Ollama (self-hosted)',
    defaultModel: OLLAMA_DEFAULT_MODEL,
    defaultEndpoint: OLLAMA_DEFAULT_BASE_URL,
    requiresApiKey: false,
    keyEnvVar: null,
    supportsBaseUrl: true,
    intentSensitive: false,
    disclosure: {
      dataRegion: { code: 'SELF_HOSTED', label: 'Self-hosted' },
      retention:
        'Text is embedded on the configured Ollama host and is not sent to any third party. No provider retains it.',
      policyUrl: null,
      usedForTraining: false,
      selfHosted: true,
    },
  },
  cohere: {
    id: 'cohere',
    name: 'Cohere',
    defaultModel: COHERE_DEFAULT_MODEL,
    defaultEndpoint: COHERE_DEFAULT_ENDPOINT,
    requiresApiKey: true,
    keyEnvVar: 'COHERE_API_KEY',
    supportsBaseUrl: true,
    intentSensitive: true,
    disclosure: {
      dataRegion: { code: 'US', label: 'United States' },
      retention:
        'Text sent to the Cohere API is processed on Cohere infrastructure and is not used to train Cohere models unless you opt in.',
      policyUrl: 'https://cohere.com/privacy',
      usedForTraining: false,
      selfHosted: false,
    },
  },
};

export const DEFAULT_PROVIDER: EmbeddingProviderId = 'openai';

export function defaultModelFor(provider: EmbeddingProviderId): string {
  return PROVIDER_CATALOGUE[provider].defaultModel;
}

/**
 * The value written to `embedding_records.embedding_model` and compared on
 * dedup. OpenAI keeps the bare model name so every row written before this
 * layer existed (`text-embedding-3-small`) still counts as current; other
 * providers are prefixed so two providers' same-named models never collide.
 * Cut to the column width (VarChar(80)).
 */
export function modelTag(provider: EmbeddingProviderId, model: string): string {
  const tag = provider === 'openai' ? model : `${provider}/${model}`;
  return tag.slice(0, 80);
}

/**
 * Hosts a project member must not be allowed to point the API at: loopback,
 * private ranges, link-local (cloud metadata lives there), single-label Docker
 * service names and `.internal` / `.local` suffixes. Public hostnames that
 * resolve to private addresses are not detected here.
 */
export function isPrivateHost(url: string): boolean {
  let host: string;
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return true;
  }
  if (host.startsWith('[') && host.endsWith(']')) host = host.slice(1, -1);
  if (host === 'localhost' || host.endsWith('.localhost')) return true;
  if (host.endsWith('.internal') || host.endsWith('.local')) return true;
  if (!host.includes('.') && !host.includes(':')) return true; // docker service / bare name

  const v4 = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])];
    if (a === 10 || a === 127 || a === 0) return true;
    if (a === 169 && b === 254) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 100 && b >= 64 && b <= 127) return true; // carrier-grade NAT
    return false;
  }
  if (host.includes(':')) {
    if (host === '::1' || host === '::') return true;
    if (host.startsWith('fe80:') || host.startsWith('fc') || host.startsWith('fd')) return true;
    if (host.startsWith('::ffff:')) return isPrivateHost(`http://${host.slice(7)}`);
  }
  return false;
}

/** Build a concrete provider; throws `auth` when a required key is missing. */
export function createProvider(cfg: EmbeddingProviderConfig): EmbeddingProvider {
  // Every embedding call — platform store or a project's own provider — goes through here.
  if (!aiEnabled()) throw new Error(AI_DISABLED_MESSAGE);
  const entry = PROVIDER_CATALOGUE[cfg.provider];
  const model = cfg.model?.trim() || entry.defaultModel;
  if (entry.requiresApiKey && !cfg.apiKey) {
    throw new EmbeddingProviderError(
      cfg.provider,
      undefined,
      'auth',
      `No ${entry.name} API key configured. Set a per-project key or the platform ${entry.keyEnvVar}.`,
    );
  }
  switch (cfg.provider) {
    case 'openai':
      return new OpenAiEmbeddingProvider(model, cfg.apiKey!, cfg.baseUrl, cfg.dimensions);
    case 'ollama':
      return new OllamaEmbeddingProvider(model, cfg.baseUrl, cfg.apiKey);
    case 'cohere':
      return new CohereEmbeddingProvider(model, cfg.apiKey!, cfg.baseUrl, cfg.dimensions);
  }
}

/** The endpoint a config will use, without constructing the provider. */
export function endpointFor(cfg: EmbeddingProviderConfig): string {
  const entry = PROVIDER_CATALOGUE[cfg.provider];
  const base = cfg.baseUrl?.trim();
  if (cfg.provider === 'ollama') return normalizeOllamaBaseUrl(base || entry.defaultEndpoint);
  return (base || entry.defaultEndpoint).replace(/\/+$/, '');
}

export interface PlatformEmbeddingSettings {
  primary: EmbeddingProviderConfig;
  fallback: EmbeddingProviderConfig | null;
  /** Platform-level keys by provider, used when a project sets none. */
  keys: Record<EmbeddingProviderId, string | null>;
  /** ISO country / region of the host that stores vectors and runs Ollama ('' = not specified). */
  hostRegion: string;
  allowPrivateBaseUrl: boolean;
  failoverCooldownSec: number;
  reembedMaxRows: number;
  /** Set when EMBEDDING_PROVIDER named something unknown; the primary fell back to openai. */
  warning: string | null;
}

/** The slice of Nest's ConfigService this module reads (also satisfied by a plain object in tests). */
export interface ConfigReader {
  get(key: string): unknown;
}

/** Read the platform embedding settings from the Nest ConfigService. */
export function resolvePlatformSettings(config: ConfigReader): PlatformEmbeddingSettings {
  const str = (key: string): string => {
    const v = config.get(key);
    return typeof v === 'string' ? v.trim() : v == null ? '' : String(v).trim();
  };
  const num = (key: string, dflt: number): number => {
    const v = Number(config.get(key));
    return Number.isFinite(v) && v > 0 ? v : dflt;
  };
  const bool = (key: string): boolean => {
    const v = config.get(key);
    return v === true || v === 'true';
  };

  const keys: Record<EmbeddingProviderId, string | null> = {
    openai: str('openai.apiKey') || null,
    ollama: str('embedding.ollama.apiKey') || null,
    cohere: str('embedding.cohere.apiKey') || null,
  };
  const ollamaBase = str('embedding.ollama.baseUrl') || null;

  let warning: string | null = null;
  const requested = str('embedding.provider');
  let primaryId: EmbeddingProviderId = DEFAULT_PROVIDER;
  if (requested) {
    if (isEmbeddingProviderId(requested)) primaryId = requested;
    else
      warning = `EMBEDDING_PROVIDER="${requested}" is not one of ${EMBEDDING_PROVIDER_IDS.join(', ')}; using ${DEFAULT_PROVIDER}.`;
  }

  const build = (
    id: EmbeddingProviderId,
    model: string,
    baseUrl: string,
    dimensions: string,
  ): EmbeddingProviderConfig => ({
    provider: id,
    model: model || defaultModelFor(id),
    baseUrl: baseUrl || (id === 'ollama' ? ollamaBase : null),
    apiKey: keys[id],
    dimensions: Number(dimensions) > 0 ? Number(dimensions) : null,
  });

  const primary = build(
    primaryId,
    str('embedding.model'),
    str('embedding.baseUrl'),
    str('embedding.dimensions'),
  );

  let fallback: EmbeddingProviderConfig | null = null;
  const fallbackId = str('embedding.fallback.provider');
  if (fallbackId) {
    if (isEmbeddingProviderId(fallbackId)) {
      fallback = build(
        fallbackId,
        str('embedding.fallback.model'),
        str('embedding.fallback.baseUrl'),
        str('embedding.fallback.dimensions'),
      );
    } else {
      warning = [warning, `EMBEDDING_FALLBACK_PROVIDER="${fallbackId}" is unknown; no failover configured.`]
        .filter(Boolean)
        .join(' ');
    }
  }

  return {
    primary,
    fallback,
    keys,
    hostRegion: str('embedding.hostRegion'),
    allowPrivateBaseUrl: bool('embedding.allowPrivateBaseUrl'),
    failoverCooldownSec: num('embedding.failoverCooldownSec', 60),
    reembedMaxRows: num('embedding.reembedMaxRows', 200_000),
    warning,
  };
}
