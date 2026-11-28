import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { EntitlementKey } from './entitlement-key';

/**
 * Plan-scoped feature gating. Resolves project → team → active subscription →
 * plan → `features` JSON. Default-allow: a feature is permitted unless the
 * plan explicitly sets it to `false`, so introducing this never breaks an
 * existing project/plan.
 */
/** Plans that include the AI assistant, lowest first. Anything above Pro belongs here too. */
export const AI_PLAN_NAMES = ['pro', 'business', 'enterprise'];
export const AI_PLAN_MESSAGE = 'The basefyio AI assistant is available on the Pro plan and above. Upgrade your team plan under Billing to use it.';

/**
 * Plans whose projects may compute embeddings with the platform's provider
 * key. Unlike the assistant, the grandfathered `legacy` plan counts as Pro
 * here (owner decision). A project on its own provider key is never gated.
 */
export const EMBEDDING_PLAN_NAMES = ['pro', 'business', 'enterprise', 'legacy'];
export const EMBEDDING_PLAN_MESSAGE =
  "Computing embeddings with the platform's key is available on the Pro plan and above. Upgrade your team plan under Billing, or add your own embedding provider key in the project's AI settings.";
/** How long a team's embedding entitlement is cached; a plan change applies within this window. */
export const EMBEDDING_PLAN_CACHE_MS = 60_000;

/** 403 EMBEDDING_PLAN_REQUIRED. */
export function embeddingPlanRequiredError(): ForbiddenException {
  return new ForbiddenException({ statusCode: 403, code: 'EMBEDDING_PLAN_REQUIRED', message: EMBEDDING_PLAN_MESSAGE });
}

@Injectable()
export class EntitlementService {
  private readonly embeddingPlanCache = new Map<string, { allowed: boolean; at: number }>();

  constructor(private readonly prisma: PrismaService) {}

  private async planFeatures(projectId: string): Promise<Record<string, boolean> | null> {
    const project = await this.prisma.project.findUnique({
      where: { id: projectId },
      select: { teamId: true },
    });
    if (!project) return null;
    const sub = await this.prisma.subscription.findUnique({
      where: { teamId: project.teamId },
      select: { plan: { select: { features: true } } },
    });
    const features = sub?.plan?.features;
    return features && typeof features === 'object' ? (features as Record<string, boolean>) : {};
  }

  /** True unless the plan explicitly disables the feature. */
  async can(projectId: string, key: EntitlementKey): Promise<boolean> {
    const features = await this.planFeatures(projectId);
    if (features === null) return false; // unknown project
    return features[key] !== false;
  }

  /** Throws 404 if the project is unknown, 403 if the plan disables the feature. */
  async assertCan(projectId: string, key: EntitlementKey): Promise<void> {
    const features = await this.planFeatures(projectId);
    if (features === null) throw new NotFoundException('Project not found');
    if (features[key] === false) {
      throw new ForbiddenException(`Your plan does not include this feature (${key})`);
    }
  }

  /**
   * The basefyio AI assistant calls a paid model, so it is opt-in by plan
   * rather than default-allow: Pro and above, or a plan whose `features`
   * sets `ai: true`. `ai: false` switches it off on any plan. A team
   * without a subscription row counts as Free.
   */
  async teamCanUseAi(teamId: string | null | undefined): Promise<boolean> {
    if (!teamId) return false;
    const sub = await this.prisma.subscription.findUnique({
      where: { teamId },
      select: { plan: { select: { name: true, features: true } } },
    });
    const plan = sub?.plan;
    if (!plan) return false;
    const features = plan.features && typeof plan.features === 'object' ? (plan.features as Record<string, unknown>) : {};
    if (features.ai === false) return false;
    if (features.ai === true) return true;
    // An Enterprise plan under another name (features.enterprise) is above Pro too.
    if (features.enterprise === true) return true;
    return AI_PLAN_NAMES.includes(plan.name.toLowerCase());
  }

  /** Throws 403 with an upgrade message when the team's plan does not include the AI assistant. */
  async assertTeamCanUseAi(teamId: string | null | undefined): Promise<void> {
    if (!(await this.teamCanUseAi(teamId))) {
      throw new ForbiddenException(AI_PLAN_MESSAGE);
    }
  }

  /**
   * Whether the team's projects may compute embeddings with the platform's
   * key: Pro, Business, Enterprise (or `features.enterprise`), and Legacy.
   * `features.embeddings` overrides the name both ways. No subscription
   * row counts as Free. Cached per team for EMBEDDING_PLAN_CACHE_MS.
   */
  async teamCanUsePlatformEmbeddings(teamId: string | null | undefined): Promise<boolean> {
    if (!teamId) return false;
    const cached = this.embeddingPlanCache.get(teamId);
    if (cached && Date.now() - cached.at < EMBEDDING_PLAN_CACHE_MS) return cached.allowed;
    const sub = await this.prisma.subscription.findUnique({
      where: { teamId },
      select: { plan: { select: { name: true, features: true } } },
    });
    const plan = sub?.plan;
    let allowed = false;
    if (plan) {
      const features = plan.features && typeof plan.features === 'object' ? (plan.features as Record<string, unknown>) : {};
      if (features.embeddings === true) allowed = true;
      else if (features.embeddings === false) allowed = false;
      else if (features.enterprise === true) allowed = true;
      else allowed = EMBEDDING_PLAN_NAMES.includes(String(plan.name).toLowerCase());
    }
    if (this.embeddingPlanCache.size > 10_000) this.embeddingPlanCache.clear();
    this.embeddingPlanCache.set(teamId, { allowed, at: Date.now() });
    return allowed;
  }

  /** Throws 403 EMBEDDING_PLAN_REQUIRED when the team may not embed on the platform's key. */
  async assertTeamCanUsePlatformEmbeddings(teamId: string | null | undefined): Promise<void> {
    if (!(await this.teamCanUsePlatformEmbeddings(teamId))) throw embeddingPlanRequiredError();
  }

  /** All entitlement keys with their effective allowed state (for UI). */
  async resolve(projectId: string): Promise<Record<string, boolean>> {
    const features = (await this.planFeatures(projectId)) ?? {};
    const out: Record<string, boolean> = {};
    for (const key of Object.values(EntitlementKey)) {
      out[key] = features[key] !== false;
    }
    return out;
  }
}
