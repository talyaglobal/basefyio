/**
 * Which stage the product is in. Read from RELEASE_STAGE; unset means beta,
 * so the badge on e-mails and invoices stays until someone decides, in
 * writing, that it goes. `GET /api/health` publishes it so the CLI and the
 * dashboard can agree with the API.
 */
export type ReleaseStage = 'beta' | 'ga';

export const RELEASE_LABEL = 'beta';

export function releaseStage(): ReleaseStage {
  const raw = (process.env.RELEASE_STAGE || '').trim().toLowerCase();
  return raw === 'ga' ? 'ga' : 'beta';
}

export function isBeta(): boolean {
  return releaseStage() === 'beta';
}
