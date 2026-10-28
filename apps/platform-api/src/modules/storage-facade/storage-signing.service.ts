import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash } from 'crypto';
import * as jwt from 'jsonwebtoken';
import { StorageFacadeError } from './storage-facade.errors';

/** Supabase's fixed lifetime for a signed upload URL. */
export const SIGNED_UPLOAD_SECONDS = 7200;
/** One year, Supabase's own ceiling. */
export const DEFAULT_SIGNED_URL_MAX_SECONDS = 365 * 24 * 60 * 60;

export interface SignedTransform {
  width?: number;
  height?: number;
  resize?: string;
  format?: string;
  quality?: number;
}

export interface SignedDownload {
  kind: 'download';
  /** Project id. */
  pid: string;
  /** `bucket/key`. */
  url: string;
  /** Transform options, when the URL points at the render route. */
  t?: SignedTransform;
}

export interface SignedUpload {
  kind: 'upload';
  pid: string;
  url: string;
  owner?: string;
  upsert: boolean;
}

export type SignedClaims = SignedDownload | SignedUpload;

interface SigningProject {
  id: string;
  serviceKey: string;
}

/**
 * Mints and checks the tokens behind `createSignedUrl` and
 * `createSignedUploadUrl`: HS256 JWTs naming the project, the exact object
 * and what the holder may do, so the public routes that honour them need no
 * API key and no policy evaluation — the policy was applied when the URL was
 * minted.
 *
 * The secret is STORAGE_URL_SIGNING_SECRET. When it is not set, each project
 * signs with a key derived from its own service key, which is already secret
 * and already per project; rotating the service key then invalidates the
 * project's outstanding URLs, which is the right outcome. Either way, a
 * changed secret invalidates every URL minted before it.
 */
@Injectable()
export class StorageSigningService {
  private readonly logger = new Logger(StorageSigningService.name);
  private readonly sharedSecret: string | undefined;
  readonly maxSeconds: number;

  constructor(config: ConfigService) {
    const secret = (config.get<string>('STORAGE_URL_SIGNING_SECRET') || process.env.STORAGE_URL_SIGNING_SECRET || '').trim();
    this.sharedSecret = secret || undefined;
    const max = Number(config.get<string>('STORAGE_SIGNED_URL_MAX_SECONDS') || process.env.STORAGE_SIGNED_URL_MAX_SECONDS);
    this.maxSeconds = Number.isInteger(max) && max > 0 ? max : DEFAULT_SIGNED_URL_MAX_SECONDS;
    if (!this.sharedSecret) {
      this.logger.warn(
        'STORAGE_URL_SIGNING_SECRET is not set; signed storage URLs are signed per project with a key derived from the service key',
      );
    }
  }

  /** `expiresIn` as storage-js sends it: a positive integer within the ceiling. */
  validateExpiry(raw: unknown): number {
    const n = Number(raw);
    if (!Number.isInteger(n) || n < 1 || n > this.maxSeconds) {
      throw StorageFacadeError.invalid(`expiresIn must be an integer between 1 and ${this.maxSeconds} seconds`);
    }
    return n;
  }

  signDownload(project: SigningProject, bucket: string, key: string, expiresIn: number, transform?: SignedTransform): string {
    const claims: SignedDownload = { kind: 'download', pid: project.id, url: `${bucket}/${key}` };
    if (transform && Object.keys(transform).length > 0) claims.t = transform;
    return jwt.sign(claims, this.secretFor(project), { algorithm: 'HS256', expiresIn });
  }

  signUpload(project: SigningProject, bucket: string, key: string, owner: string | undefined, upsert: boolean): string {
    const claims: SignedUpload = { kind: 'upload', pid: project.id, url: `${bucket}/${key}`, upsert };
    if (owner) claims.owner = owner;
    return jwt.sign(claims, this.secretFor(project), { algorithm: 'HS256', expiresIn: SIGNED_UPLOAD_SECONDS });
  }

  /** The project a token names, read before the signature can be checked. */
  peekProjectId(token: string): string {
    const decoded = jwt.decode(token);
    const pid = decoded && typeof decoded === 'object' ? (decoded as { pid?: unknown }).pid : undefined;
    if (typeof pid !== 'string' || !pid) throw StorageFacadeError.invalidJwt();
    return pid;
  }

  /**
   * Checks signature and expiry, and that the token was minted for exactly
   * this object and purpose. A token for `a/b.png` opens nothing else.
   */
  verify<K extends SignedClaims['kind']>(
    token: string,
    project: SigningProject,
    kind: K,
    bucket: string,
    key: string,
  ): Extract<SignedClaims, { kind: K }> {
    let claims: SignedClaims;
    try {
      claims = jwt.verify(token, this.secretFor(project), { algorithms: ['HS256'] }) as SignedClaims;
    } catch (err: any) {
      throw StorageFacadeError.invalidJwt(err?.name === 'TokenExpiredError' ? 'jwt expired' : 'Invalid or expired token');
    }
    if (claims.kind !== kind || claims.pid !== project.id || claims.url !== `${bucket}/${key}`) {
      throw StorageFacadeError.invalidJwt('The token was not issued for this object');
    }
    return claims as Extract<SignedClaims, { kind: K }>;
  }

  private secretFor(project: SigningProject): string {
    if (this.sharedSecret) return this.sharedSecret;
    return createHash('sha256').update(`storage-url-signing:${project.serviceKey}`).digest('hex');
  }
}
