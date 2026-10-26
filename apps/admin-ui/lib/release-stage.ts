/**
 * Which stage the product is in, for the one place that word appears: next
 * to the mark. Inlined at build time from NEXT_PUBLIC_RELEASE_STAGE, so the
 * value has to be in the build's environment (the deploy workflow reads it
 * from .env.production). Unset means beta: the badge stays until someone
 * decides, in writing, that it goes.
 */
export type ReleaseStage = 'beta' | 'ga';

export const RELEASE_LABEL = 'beta';

export function releaseStage(): ReleaseStage {
  const raw = (process.env.NEXT_PUBLIC_RELEASE_STAGE || '').trim().toLowerCase();
  return raw === 'ga' ? 'ga' : 'beta';
}

export function isBeta(): boolean {
  return releaseStage() === 'beta';
}
