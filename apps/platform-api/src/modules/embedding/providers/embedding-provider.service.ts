import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  EmbedIntent,
  EmbedResult,
  EmbeddingProvider,
  EmbeddingProviderConfig,
  EmbeddingProviderError,
  ProviderErrorKind,
} from './embedding-provider';
import {
  PROVIDER_CATALOGUE,
  PlatformEmbeddingSettings,
  createProvider,
  endpointFor,
  modelTag,
  resolvePlatformSettings,
} from './provider-registry';
import { ConfigSource, KeySource } from './disclosure';

/** The subset of Project a provider is derived from. */
export interface ProjectEmbeddingFields {
  embeddingProvider?: string | null;
  embeddingModel?: string | null;
  embeddingBaseUrl?: string | null;
  embeddingApiKey?: string | null;
}

/** A configuration described without constructing anything — never throws. */
export interface ProviderDescription {
  config: EmbeddingProviderConfig;
  tag: string;
  source: ConfigSource;
  keySource: KeySource;
  fallback: EmbeddingProviderConfig | null;
  /** The endpoint is the platform's own default for this provider. */
  endpointIsPlatformHost: boolean;
}

export interface ResolvedProvider extends ProviderDescription {
  provider: EmbeddingProvider;
}

export interface EmbedOptions {
  intent?: EmbedIntent;
  /** Width of the destination column. Shorter vectors are zero-padded; longer ones are refused. */
  targetDimensions?: number | null;
  signal?: AbortSignal;
}

export interface EmbedOutcome extends EmbedResult {
  usedFallback: boolean;
  padded: boolean;
  nativeDimensions: number;
  tag: string;
}

const FAILOVER_KINDS: ReadonlySet<ProviderErrorKind> = new Set([
  'auth',
  'quota',
  'unavailable',
  'unknown',
]);

/** One short text is enough to learn a model's width and prove the credentials. */
const PROBE_TEXT = 'basefyio embedding probe';
const PROBE_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * Zero-pad vectors up to `target`. Appending zeros changes neither dot
 * products nor norms, so cosine distance between two vectors of the same model
 * is exactly preserved and the HNSW cosine index keeps working. Vectors wider
 * than the column cannot be fitted and are refused.
 */
export function fitDimensions(
  vectors: number[][],
  target: number | null | undefined,
  tag: string,
  provider: EmbeddingProviderConfig['provider'] = 'openai',
): { vectors: number[][]; padded: boolean } {
  if (!target || vectors.length === 0) return { vectors, padded: false };
  const width = vectors[0].length;
  if (width === target) return { vectors, padded: false };
  if (width > target) {
    throw new EmbeddingProviderError(
      provider,
      undefined,
      'input',
      `${tag} produces ${width}-dimensional vectors but the vector store holds ${target}. Choose a model with at most ${target} dimensions, or set a smaller output dimension where the model supports it.`,
    );
  }
  const pad = new Array<number>(target - width).fill(0);
  return { vectors: vectors.map((v) => v.concat(pad)), padded: true };
}

/**
 * Builds providers from platform settings and per-project overrides, runs the
 * failover circuit, fits vector widths and probes models. It owns no cache, no
 * budget and no database access — those stay with the two callers.
 */
@Injectable()
export class EmbeddingProviderService {
  private readonly logger = new Logger(EmbeddingProviderService.name);
  private settingsCache: PlatformEmbeddingSettings | null = null;
  private platformCache: ResolvedProvider | null | undefined;
  private readonly downUntil = new Map<string, number>();
  private readonly paddingLogged = new Set<string>();
  private readonly probeCache = new Map<string, { dimensions: number; at: number }>();

  constructor(private readonly config: ConfigService) {}

  settings(): PlatformEmbeddingSettings {
    if (!this.settingsCache) {
      this.settingsCache = resolvePlatformSettings({ get: (key) => this.config.get(key) });
      if (this.settingsCache.warning) this.logger.error(this.settingsCache.warning);
    }
    return this.settingsCache;
  }

  /** Describe the platform configuration (never throws). */
  describePlatform(): ProviderDescription {
    const s = this.settings();
    return {
      config: s.primary,
      tag: modelTag(s.primary.provider, s.primary.model || PROVIDER_CATALOGUE[s.primary.provider].defaultModel),
      source: 'platform',
      // 'none' also for providers that need no key (Ollama); callers combine it with requiresApiKey.
      keySource: s.primary.apiKey ? 'platform' : 'none',
      fallback: s.fallback,
      endpointIsPlatformHost: true,
    };
  }

  /**
   * The platform provider, or null when it needs a key that is not set. Logged
   * once; the caller decides how to degrade (the platform EmbeddingService
   * returns null from every call, as it did without OPENAI_API_KEY).
   */
  platform(): ResolvedProvider | null {
    if (this.platformCache !== undefined) return this.platformCache;
    const desc = this.describePlatform();
    try {
      const resolved = this.materialize(desc);
      this.logger.log(
        `Embedding provider: ${resolved.tag} at ${resolved.provider.endpoint}` +
          (resolved.fallback
            ? ` (fallback ${modelTag(resolved.fallback.provider, resolved.fallback.model || '')})`
            : ''),
      );
      if (resolved.fallback) {
        const fbTag = modelTag(
          resolved.fallback.provider,
          resolved.fallback.model || PROVIDER_CATALOGUE[resolved.fallback.provider].defaultModel,
        );
        if (fbTag !== resolved.tag) {
          this.logger.warn(
            `Embedding fallback ${fbTag} produces a different vector space than ${resolved.tag}; search relevance during failover will be degraded.`,
          );
        }
      }
      this.platformCache = resolved;
    } catch (err: any) {
      // The caller (EmbeddingService) logs the "disabled" line; keep this one quiet.
      this.platformCache = null;
      this.logger.debug(err?.message ?? String(err));
    }
    return this.platformCache;
  }

  /**
   * Describe what a project would use: its own override, or the platform
   * configuration with the project's key taking precedence over the platform key.
   */
  describeProject(p: ProjectEmbeddingFields): ProviderDescription {
    const s = this.settings();
    const projectKey = p.embeddingApiKey?.trim() || null;

    if (!p.embeddingProvider) {
      const base = this.describePlatform();
      if (projectKey) {
        return {
          ...base,
          config: { ...base.config, apiKey: projectKey },
          source: 'platform',
          keySource: 'project',
          // A project paying with its own key does not silently fall over to a platform-paid provider.
          fallback: null,
        };
      }
      return base;
    }

    const provider = p.embeddingProvider as EmbeddingProviderConfig['provider'];
    const entry = PROVIDER_CATALOGUE[provider];
    const platformKey = s.keys[provider];
    const config: EmbeddingProviderConfig = {
      provider,
      model: p.embeddingModel?.trim() || entry.defaultModel,
      baseUrl:
        p.embeddingBaseUrl?.trim() || (provider === 'ollama' ? this.platformOllamaBase() : null),
      apiKey: projectKey ?? platformKey,
      dimensions: null,
    };
    return {
      config,
      tag: modelTag(provider, config.model!),
      source: 'project',
      keySource: projectKey ? 'project' : platformKey ? 'platform' : 'none',
      fallback: null,
      endpointIsPlatformHost: !p.embeddingBaseUrl?.trim(),
    };
  }

  /** Build the provider a project uses; throws BadRequest when a required key is missing. */
  forProject(p: ProjectEmbeddingFields): ResolvedProvider {
    const desc = this.describeProject(p);
    try {
      return this.materialize(desc);
    } catch (err: any) {
      if (err instanceof EmbeddingProviderError && err.kind === 'auth') {
        throw new BadRequestException(err.message);
      }
      throw err;
    }
  }

  /**
   * Embed with failover and width fitting.
   *
   * Failover is used for auth / quota / unreachable / unexplained HTTP errors
   * when a fallback is configured; a rejected input is the caller's problem and
   * is never retried elsewhere. A failed primary is skipped for the cooldown
   * so a dead endpoint is not hammered on every request.
   */
  async embed(
    resolved: ResolvedProvider,
    texts: string[],
    opts: EmbedOptions = {},
  ): Promise<EmbedOutcome> {
    const intent = opts.intent ?? 'document';
    const primaryKey = this.circuitKey(resolved.provider);
    const fallback = resolved.fallback ? this.fallbackProvider(resolved.fallback) : null;

    let result: EmbedResult;
    let usedFallback = false;
    let tag = resolved.tag;

    const now = Date.now();
    if (fallback && (this.downUntil.get(primaryKey) ?? 0) > now) {
      result = await fallback.embed(texts, { intent, signal: opts.signal });
      usedFallback = true;
      tag = modelTag(fallback.id, fallback.model);
    } else {
      try {
        result = await resolved.provider.embed(texts, { intent, signal: opts.signal });
        this.downUntil.delete(primaryKey);
      } catch (err) {
        if (
          fallback &&
          err instanceof EmbeddingProviderError &&
          FAILOVER_KINDS.has(err.kind)
        ) {
          const cooldownSec = this.settings().failoverCooldownSec;
          this.downUntil.set(primaryKey, Date.now() + cooldownSec * 1000);
          this.logger.error(
            `Embedding primary ${resolved.tag} failed (${err.kind}: ${err.message}); using fallback ${modelTag(fallback.id, fallback.model)} for ${cooldownSec}s`,
          );
          result = await fallback.embed(texts, { intent, signal: opts.signal });
          usedFallback = true;
          tag = modelTag(fallback.id, fallback.model);
        } else {
          throw err;
        }
      }
    }

    const nativeDimensions = result.dimensions;
    const fitted = fitDimensions(
      result.vectors,
      opts.targetDimensions,
      tag,
      usedFallback && fallback ? fallback.id : resolved.config.provider,
    );
    if (fitted.padded && !this.paddingLogged.has(tag)) {
      this.paddingLogged.add(tag);
      this.logger.log(
        `Embeddings from ${tag} are ${nativeDimensions}-dimensional and are stored zero-padded to ${opts.targetDimensions}`,
      );
    }
    return {
      ...result,
      vectors: fitted.vectors,
      padded: fitted.padded,
      nativeDimensions,
      usedFallback,
      tag,
    };
  }

  /**
   * Learn a model's native width and prove the credentials with one tiny
   * request. Cached per endpoint+model for a day so status pages cost nothing.
   */
  async probe(resolved: ResolvedProvider): Promise<{ dimensions: number; model: string }> {
    const key = this.circuitKey(resolved.provider) + `#${resolved.config.dimensions ?? ''}`;
    const cached = this.probeCache.get(key);
    if (cached && Date.now() - cached.at < PROBE_TTL_MS) {
      return { dimensions: cached.dimensions, model: resolved.provider.model };
    }
    const result = await resolved.provider.embed([PROBE_TEXT], { intent: 'query' });
    if (!result.vectors[0]?.length) {
      throw new EmbeddingProviderError(
        resolved.config.provider,
        undefined,
        'unknown',
        `${resolved.tag} returned an empty vector for the probe text`,
      );
    }
    this.probeCache.set(key, { dimensions: result.dimensions, at: Date.now() });
    return { dimensions: result.dimensions, model: resolved.provider.model };
  }

  /** Cached native width, or null when it cannot be determined right now. */
  async dimensionsFor(resolved: ResolvedProvider): Promise<number | null> {
    try {
      return (await this.probe(resolved)).dimensions;
    } catch {
      return null;
    }
  }

  // ── internals ─────────────────────────────────────────────

  private materialize(desc: ProviderDescription): ResolvedProvider {
    return { ...desc, provider: createProvider(desc.config) };
  }

  private fallbackProvider(cfg: EmbeddingProviderConfig): EmbeddingProvider | null {
    try {
      return createProvider(cfg);
    } catch (err: any) {
      this.logger.warn(`Embedding fallback is not usable: ${err?.message ?? err}`);
      return null;
    }
  }

  private circuitKey(p: EmbeddingProvider): string {
    return `${p.id}/${p.model}@${p.endpoint}`;
  }

  private platformOllamaBase(): string | null {
    const s = this.settings();
    if (s.primary.provider === 'ollama' && s.primary.baseUrl) return s.primary.baseUrl;
    if (s.fallback?.provider === 'ollama' && s.fallback.baseUrl) return s.fallback.baseUrl;
    const v = this.config.get<unknown>('embedding.ollama.baseUrl');
    return typeof v === 'string' && v.trim() ? v.trim() : null;
  }

  /** The endpoint a description would use (for disclosure without constructing a provider). */
  endpointOf(desc: ProviderDescription): string {
    return endpointFor(desc.config);
  }
}
