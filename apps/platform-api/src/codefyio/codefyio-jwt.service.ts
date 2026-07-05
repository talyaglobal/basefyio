import { Injectable, Logger, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as jwt from 'jsonwebtoken';
import jwksClient, { JwksClient } from 'jwks-rsa';
import { AdapterSessionClaims, CodefyioClaims } from './codefyio.types';

const SESSION_AUDIENCE = 'codefyio-adapter';

/**
 * Verifies Codefyio-issued JWTs (the trust bridge — the user is already signed
 * into Codefyio) and mints/verifies our own short-lived adapter session tokens.
 * Supports an HS256 shared secret (simple/self-host/tests) or an RS256 JWKS
 * endpoint (production). Tokens are never logged.
 */
@Injectable()
export class CodefyioJwtService {
  private readonly logger = new Logger(CodefyioJwtService.name);
  private jwks?: JwksClient;

  constructor(private readonly config: ConfigService) {}

  /** True when a Codefyio token verifier is configured. */
  isConfigured(): boolean {
    return Boolean(
      this.config.get<string>('codefyio.jwtSecret') ||
        this.config.get<string>('codefyio.jwksUrl'),
    );
  }

  private sessionSecret(): string {
    const s = this.config.get<string>('codefyio.sessionSecret');
    if (!s) throw new UnauthorizedException('Codefyio adapter session key not configured');
    return s;
  }

  /** Verify a Codefyio JWT (signature + audience + expiry). Throws on failure. */
  async verifyCodefyioToken(token: string): Promise<CodefyioClaims> {
    if (!token) throw new UnauthorizedException('Missing Codefyio token');
    const audience = this.config.get<string>('codefyio.audience') || 'codefyio';
    const secret = this.config.get<string>('codefyio.jwtSecret');
    const jwksUrl = this.config.get<string>('codefyio.jwksUrl');

    try {
      let payload: jwt.JwtPayload;
      if (jwksUrl) {
        payload = await new Promise((resolve, reject) => {
          jwt.verify(
            token,
            (header, cb) => {
              this.getJwks(jwksUrl)
                .getSigningKey(header.kid)
                .then((k) => cb(null, k.getPublicKey()))
                .catch((e) => cb(e as Error));
            },
            { audience, algorithms: ['RS256'] },
            (err, decoded) => (err ? reject(err) : resolve(decoded as jwt.JwtPayload)),
          );
        });
      } else if (secret) {
        payload = jwt.verify(token, secret, {
          audience,
          algorithms: ['HS256'],
        }) as jwt.JwtPayload;
      } else {
        throw new Error('not_configured');
      }

      const email = (payload.email as string) || '';
      const sub = (payload.sub as string) || '';
      if (!sub) throw new Error('token has no subject');
      return { ...payload, sub, email } as CodefyioClaims;
    } catch (err: any) {
      // Never include the token in logs.
      this.logger.warn(`Codefyio token verification failed: ${err?.message ?? 'invalid'}`);
      throw new UnauthorizedException('Invalid Codefyio token');
    }
  }

  /** Issue a short-lived adapter session token bound to a basefyio account. */
  issueSession(claims: AdapterSessionClaims): { accessToken: string; expiresIn: number } {
    const expiresIn = this.config.get<number>('codefyio.sessionTtlSeconds') || 3600;
    const accessToken = jwt.sign(
      { userId: claims.userId, teamId: claims.teamId, email: claims.email },
      this.sessionSecret(),
      { algorithm: 'HS256', audience: SESSION_AUDIENCE, expiresIn },
    );
    return { accessToken, expiresIn };
  }

  /** Verify an adapter session token issued by {@link issueSession}. */
  verifySession(token: string): AdapterSessionClaims {
    if (!token) throw new UnauthorizedException('Missing session token');
    try {
      const p = jwt.verify(token, this.sessionSecret(), {
        algorithms: ['HS256'],
        audience: SESSION_AUDIENCE,
      }) as jwt.JwtPayload;
      if (!p.userId || !p.teamId) throw new Error('incomplete session');
      return { userId: p.userId as string, teamId: p.teamId as string, email: (p.email as string) || '' };
    } catch {
      throw new UnauthorizedException('Invalid or expired session token');
    }
  }

  private getJwks(url: string): JwksClient {
    if (!this.jwks) {
      this.jwks = jwksClient({ jwksUri: url, cache: true, rateLimit: true });
    }
    return this.jwks;
  }
}
