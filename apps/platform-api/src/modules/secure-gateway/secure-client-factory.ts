import { Injectable } from '@nestjs/common';
import type { CertBundleResult } from '../certificates/providers/certificate-provider.interface';
import type { ConnectionParams } from './data-storage-provider.interface';

export interface BaseConnectionTarget {
  host: string;
  port: number;
  database: string;
  username?: string;
}

@Injectable()
export class SecureClientFactory {
  /**
   * Merges a base connection target with a cert bundle to produce mTLS ConnectionParams.
   * The privateKeyPem from the bundle is held in-memory only — never persisted.
   */
  buildConnectionParams(
    base: BaseConnectionTarget,
    bundle: Pick<CertBundleResult, 'certificatePem' | 'privateKeyPem' | 'caCertPem'>,
  ): ConnectionParams {
    return {
      host: base.host,
      port: base.port,
      database: base.database,
      username: base.username,
      sslCert: bundle.certificatePem,
      sslKey: bundle.privateKeyPem,  // in-memory only — cleared on disconnect
      sslCa: bundle.caCertPem,
      requireMtls: true,
    };
  }
}
