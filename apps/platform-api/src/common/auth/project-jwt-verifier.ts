import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { HttpService } from '@nestjs/axios';
import { firstValueFrom } from 'rxjs';
import * as jwt from 'jsonwebtoken';
import jwksClient, { JwksClient } from 'jwks-rsa';

/**
 * Verifies the access tokens a project's realm issues, and serves that realm's
 * public keys.
 *
 * Extracted from ApiKeyGuard (which keeps its own copy for now) so the GoTrue
 * facade can check a user token the guard did not: a server-side call sends the
 * service key as apikey and the end user's JWT as Bearer, and the guard ignores
 * the Bearer when the key is the service key.
 *
 * Verification is RS256 against the realm's JWKS plus the issuer, and — stricter
 * than the guard — the token type and the client it was issued to: `typ` must be
 * `Bearer` (a refresh or ID token signed by the same realm is not a credential
 * here) and `azp` one of the realm's public clients, so a token any other realm
 * on the same server signed is refused even when the issuer check is somehow
 * satisfied.
 */
@Injectable()
export class ProjectJwtVerifier {
  private readonly logger = new Logger(ProjectJwtVerifier.name);
  private readonly jwksByRealm = new Map<string, JwksClient>();
  private readonly publicKeysByRealm = new Map<string, { keys: Record<string, unknown>[]; fetchedAt: number }>();

  /** How long a realm's public key set is served from memory. */
  static readonly JWKS_TTL_MS = 10 * 60 * 1000;

  constructor(
    private readonly config: ConfigService,
    private readonly http: HttpService,
  ) {}

  /** The clients whose tokens count as a user of the realm. */
  static allowedClients(realm: string): string[] {
    return [`${realm}-anon`, `${realm}-anon-aal2`];
  }

  /**
   * The verified claims, or null for anything that does not verify: bad
   * signature, expired, another realm, not an access token, unknown client.
   */
  async verify(token: string, realm: string): Promise<Record<string, unknown> | null> {
    try {
      const client = this.getJwksClient(realm);
      const payload = await new Promise<Record<string, unknown>>((resolve, reject) => {
        jwt.verify(
          token,
          (header, cb) => {
            if (!header.kid) return cb(new Error('JWT missing kid'));
            client
              .getSigningKey(header.kid)
              .then((key) => cb(null, key.getPublicKey()))
              .catch((err) => cb(err));
          },
          { algorithms: ['RS256'], issuer: this.expectedIssuer(realm) },
          (err, decoded) => {
            if (err) return reject(err);
            if (!decoded || typeof decoded !== 'object') return reject(new Error('Empty or malformed JWT payload'));
            resolve(decoded as Record<string, unknown>);
          },
        );
      });
      if (payload.typ !== undefined && payload.typ !== 'Bearer') {
        throw new Error(`not an access token (typ=${String(payload.typ)})`);
      }
      const azp = typeof payload.azp === 'string' ? payload.azp : undefined;
      if (azp && !ProjectJwtVerifier.allowedClients(realm).includes(azp)) {
        throw new Error(`issued to an unexpected client (${azp})`);
      }
      return payload;
    } catch (err: any) {
      this.logger.debug(`JWT verification failed (realm=${realm}): ${err?.message ?? err}`);
      return null;
    }
  }

  /** The claims without verification — for routing decisions only, never for identity. */
  decode(token: string | undefined | null): Record<string, unknown> | null {
    const part = token?.split('.')[1];
    if (!part) return null;
    try {
      const parsed = JSON.parse(Buffer.from(part, 'base64url').toString('utf8'));
      return parsed && typeof parsed === 'object' ? parsed : null;
    } catch {
      return null;
    }
  }

  /**
   * The realm's signing keys as a JWK set, for `GET /auth/v1/.well-known/jwks.json`
   * (what `supabase.auth.getClaims()` verifies against). Only signature keys, and
   * only their public parts, cached for ten minutes per realm.
   */
  async getJwks(realm: string): Promise<{ keys: Record<string, unknown>[] }> {
    const cached = this.publicKeysByRealm.get(realm);
    if (cached && Date.now() - cached.fetchedAt < ProjectJwtVerifier.JWKS_TTL_MS) {
      return { keys: cached.keys };
    }
    const { data } = await firstValueFrom(this.http.get(this.jwksUri(realm), { timeout: 5000 }));
    const keys = (Array.isArray(data?.keys) ? data.keys : [])
      .filter((k: any) => k && (k.use === undefined || k.use === 'sig') && k.kty)
      .map((k: any) => {
        const { kid, kty, alg, use, n, e, crv, x, y } = k;
        return { kid, kty, alg, use: use ?? 'sig', ...(n ? { n, e } : {}), ...(crv ? { crv, x, y } : {}) };
      });
    this.publicKeysByRealm.set(realm, { keys, fetchedAt: Date.now() });
    return { keys };
  }

  expectedIssuer(realm: string): string {
    const publicBase =
      this.config.get<string>('keycloak.publicUrl') ||
      this.config.get<string>('keycloak.url') ||
      'http://localhost:8080';
    return `${publicBase.replace(/\/$/, '')}/realms/${realm}`;
  }

  private jwksUri(realm: string): string {
    const base = this.config.get<string>('keycloak.url') || 'http://localhost:8080';
    return `${base.replace(/\/$/, '')}/realms/${encodeURIComponent(realm)}/protocol/openid-connect/certs`;
  }

  private getJwksClient(realm: string): JwksClient {
    const existing = this.jwksByRealm.get(realm);
    if (existing) return existing;
    const client = jwksClient({
      jwksUri: this.jwksUri(realm),
      cache: true,
      cacheMaxAge: ProjectJwtVerifier.JWKS_TTL_MS,
      rateLimit: true,
      jwksRequestsPerMinute: 10,
      timeout: 5000,
    });
    this.jwksByRealm.set(realm, client);
    return client;
  }
}
