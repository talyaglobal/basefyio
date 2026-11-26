import { BadRequestException, Injectable, Logger } from '@nestjs/common';

const SITEVERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';

/**
 * Cloudflare Turnstile check for sign-up. It is off until both TURNSTILE_SITE_KEY and
 * TURNSTILE_SECRET_KEY are set. If Cloudflare itself cannot be reached the request is let
 * through (fail open): a Cloudflare outage must not stop customers from signing up, and the
 * per-IP rate limit still applies.
 */
@Injectable()
export class TurnstileService {
  private readonly logger = new Logger(TurnstileService.name);

  get siteKey(): string | null {
    const key = process.env.TURNSTILE_SITE_KEY?.trim();
    return key && this.secret ? key : null;
  }

  private get secret(): string | null {
    return process.env.TURNSTILE_SECRET_KEY?.trim() || null;
  }

  get enabled(): boolean {
    return this.siteKey !== null;
  }

  async assertHuman(token: string | undefined, ip?: string): Promise<void> {
    if (!this.enabled) return;
    if (!token) {
      throw new BadRequestException('Please complete the human check and try again.');
    }
    let success = false;
    try {
      const body = new URLSearchParams({ secret: this.secret as string, response: token });
      if (ip) body.set('remoteip', ip);
      const res = await fetch(SITEVERIFY_URL, {
        method: 'POST',
        body,
        signal: AbortSignal.timeout(5000),
      });
      const json = (await res.json()) as { success?: boolean };
      success = json.success === true;
    } catch (err) {
      this.logger.warn(`Turnstile verification unavailable, letting the request through: ${(err as Error).message}`);
      return;
    }
    if (!success) {
      throw new BadRequestException('The human check failed. Please reload the page and try again.');
    }
  }
}
