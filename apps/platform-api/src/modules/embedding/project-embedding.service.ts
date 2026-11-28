import {
  BadGatewayException,
  BadRequestException,
  ForbiddenException,
  HttpException,
  HttpStatus,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { aiEnabled, AI_DISABLED_MESSAGE } from '../../common/utils/ai-switch';
import {
  EmbeddingProviderService,
  type EmbedOutcome,
  type ProjectEmbeddingFields,
  type ProviderDescription,
  type ResolvedProvider,
} from './providers/embedding-provider.service';
import { EmbeddingProviderError, type EmbedIntent } from './providers/embedding-provider';
import { PROVIDER_CATALOGUE } from './providers/provider-registry';
import { EmbeddingBudgetService, estimateTokens, nextUtcMidnight } from './embedding-budget.service';
import { EntitlementService } from '../entitlement/entitlement.service';

/** 403 AI_DISABLED: the installation switched every model call off. */
export function aiDisabledError(): ForbiddenException {
  return new ForbiddenException({ statusCode: 403, code: 'AI_DISABLED', message: AI_DISABLED_MESSAGE });
}

/** A project as far as embedding it needs: its id (for the budget) and its provider fields. */
export interface ProjectEmbeddingTarget extends ProjectEmbeddingFields {
  id: string;
  /** Owning team: its plan decides whether the platform's key may be used. */
  teamId?: string | null;
}

/** What the dashboard needs to explain platform-key embedding to a project. */
export interface PlatformKeyUsage {
  /** The project's embeddings would be paid with the platform's key. */
  platformKey: boolean;
  /** The team's plan allows that (always true on the project's own key). */
  platformKeyAllowed: boolean;
  /** Daily token limit on the platform key; null when unlimited or not on the platform key. */
  limit: number | null;
  /** Tokens used today (UTC); null when unknown or not on the platform key. */
  used: number | null;
  /** When today's counter resets; null when not on the platform key. */
  resetsAt: string | null;
}

/**
 * Embeddings paid by the platform: its key, or (keyless providers such as
 * Ollama) its own endpoint. A project's own key or own endpoint is not.
 */
export function paidByPlatform(resolved: Pick<ProviderDescription, 'keySource' | 'endpointIsPlatformHost'>): boolean {
  if (resolved.keySource === 'platform') return true;
  return resolved.keySource === 'none' && resolved.endpointIsPlatformHost === true;
}

export interface EmbedForProjectOptions {
  intent: EmbedIntent;
  /** Width of the destination (shorter vectors are zero-padded, wider refused). */
  targetDimensions?: number | null;
  /** The provider already resolved for this project (saves a second resolve). */
  resolved?: ResolvedProvider;
  /**
   * false: rethrow the provider's own error instead of the mapped HTTP error
   * (background jobs that record the provider's message). Default true.
   */
  mapErrors?: boolean;
}

export interface ProjectEmbedResult {
  /** One vector per text, in input order. */
  vectors: number[][];
  /** Tokens the provider billed for the request (null when it does not say). */
  tokenCount: number | null;
  /** tokenCount spread evenly over the texts (0 when unknown). */
  perItemTokens: number;
  /** Model tag that produced the vectors (the fallback's when failover was used). */
  tag: string;
  nativeDimensions: number;
}

/**
 * One way to embed text for a project: resolve its provider (AI switch → 403,
 * missing key → 400), check the per-project daily budget when the platform's
 * key pays, call the provider with failover and width fitting, map provider
 * failures to HTTP errors that say what went wrong, and count the tokens.
 * Used by the pgvector store and by Data Engine platform vectors.
 */
@Injectable()
export class ProjectEmbeddingService {
  private readonly logger = new Logger(ProjectEmbeddingService.name);

  constructor(
    private readonly providers: EmbeddingProviderService,
    private readonly budget: EmbeddingBudgetService,
    private readonly prisma: PrismaService,
    private readonly entitlements: EntitlementService,
  ) {}

  /** The embedding fields of an active project; 404 when there is none. */
  async loadProject(projectId: string): Promise<ProjectEmbeddingTarget> {
    const project = await this.prisma.project.findFirst({
      where: { id: projectId, status: 'ACTIVE' },
      select: {
        id: true,
        teamId: true,
        embeddingApiKey: true,
        embeddingProvider: true,
        embeddingModel: true,
        embeddingBaseUrl: true,
      },
    });
    if (!project) throw new NotFoundException('Project not found');
    return project;
  }

  /** What the project would use, without constructing anything (never throws). */
  describe(project: ProjectEmbeddingFields): ProviderDescription {
    return this.providers.describeProject(project);
  }

  /** forProject, with the AI switch answered as 403 AI_DISABLED instead of a 500. */
  resolve(project: ProjectEmbeddingFields): ResolvedProvider {
    if (!aiEnabled()) throw aiDisabledError();
    try {
      return this.providers.forProject(project);
    } catch (err) {
      if (err instanceof Error && err.message === AI_DISABLED_MESSAGE) throw aiDisabledError();
      throw err;
    }
  }

  /** Native width of the project's model (one cached probe); provider errors mapped. */
  async dimensions(resolved: ResolvedProvider): Promise<number> {
    try {
      return (await this.providers.probe(resolved)).dimensions;
    } catch (err) {
      throw this.providerError(err);
    }
  }

  async embedForProject(
    project: ProjectEmbeddingTarget,
    texts: string[],
    opts: EmbedForProjectOptions,
  ): Promise<ProjectEmbedResult> {
    const resolved = opts.resolved ?? this.resolve(project);
    if (texts.length === 0) {
      return { vectors: [], tokenCount: 0, perItemTokens: 0, tag: resolved.tag, nativeDimensions: 0 };
    }
    // Own key: never gated, never limited. Platform key: plan (403), then daily budget (429).
    const platform = paidByPlatform(resolved);
    if (platform) {
      await this.assertPlatformKeyAllowed(project, resolved);
      await this.budget.assertWithinBudget(project.id, 'platform', estimateTokens(texts));
    }

    let out: EmbedOutcome;
    try {
      out = await this.providers.embed(resolved, texts, {
        intent: opts.intent,
        targetDimensions: opts.targetDimensions ?? null,
      });
    } catch (err) {
      throw opts.mapErrors === false ? err : this.providerError(err);
    }

    // Bill what the provider reports; estimate when it reports nothing.
    if (platform) await this.budget.record(project.id, out.tokenCount ?? estimateTokens(texts), 'platform');
    return {
      vectors: out.vectors,
      tokenCount: out.tokenCount,
      perItemTokens: Math.round((out.tokenCount ?? 0) / texts.length),
      tag: out.tag,
      nativeDimensions: out.nativeDimensions,
    };
  }

  /**
   * 403 EMBEDDING_PLAN_REQUIRED when the project would embed with the
   * platform's key and its team's plan is below Pro. Nothing on its own key.
   */
  async assertPlatformKeyAllowed(
    project: ProjectEmbeddingTarget,
    resolved: Pick<ProviderDescription, 'keySource' | 'endpointIsPlatformHost'>,
  ): Promise<void> {
    if (!paidByPlatform(resolved)) return;
    await this.entitlements.assertTeamCanUsePlatformEmbeddings(await this.teamOf(project));
  }

  /** Plan and daily-limit facts for status pages (never throws). */
  async platformKeyUsage(project: ProjectEmbeddingTarget): Promise<PlatformKeyUsage> {
    const desc = this.describe(project);
    if (!paidByPlatform(desc)) {
      return { platformKey: false, platformKeyAllowed: true, limit: null, used: null, resetsAt: null };
    }
    let allowed = false;
    try {
      allowed = await this.entitlements.teamCanUsePlatformEmbeddings(await this.teamOf(project));
    } catch {
      allowed = false;
    }
    return {
      platformKey: true,
      platformKeyAllowed: allowed,
      limit: this.budget.limit(),
      used: await this.budget.used(project.id),
      resetsAt: nextUtcMidnight().toISOString(),
    };
  }

  private async teamOf(project: ProjectEmbeddingTarget): Promise<string | null> {
    if (project.teamId !== undefined) return project.teamId;
    const row = await this.prisma.project.findUnique({ where: { id: project.id }, select: { teamId: true } });
    return row?.teamId ?? null;
  }

  /**
   * Provider failures mapped to HTTP errors that say what went wrong —
   * unmapped, a 401 or quota error would surface as a bare 500.
   */
  providerError(err: unknown): HttpException {
    if (err instanceof HttpException) return err;
    if (err instanceof Error && err.message === AI_DISABLED_MESSAGE) return aiDisabledError();
    const pe = err instanceof EmbeddingProviderError ? err : null;
    const status = pe?.status;
    const detail = err instanceof Error ? err.message : String(err);
    const name = pe ? PROVIDER_CATALOGUE[pe.provider].name : 'the embedding provider';
    this.logger.error(`Embedding provider error (status ${status ?? 'n/a'}): ${detail}`);

    if (pe?.kind === 'auth') {
      return new BadGatewayException(
        `Embedding provider rejected the API key. Check the project or platform ${name} key.`,
      );
    }
    if (pe?.kind === 'quota') {
      return new HttpException(
        'Embedding provider rate limit or quota exceeded. Retry later.',
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
    if (pe?.kind === 'input') {
      return new BadRequestException(`Embedding provider rejected the input: ${detail}`);
    }
    if (pe?.kind === 'unavailable' || !status) {
      return new BadGatewayException(`Could not reach the embedding provider (${name}).`);
    }
    return new BadGatewayException(`Embedding provider error (HTTP ${status}).`);
  }
}
