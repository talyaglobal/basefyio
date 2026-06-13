export const CERTIFICATE_PROVIDER = 'CERTIFICATE_PROVIDER';

export interface IssueCertParams {
  projectId: string;
  accessLevel: 'READ' | 'READ_WRITE';
  /** TTL in days, defaults to 365 */
  ttlDays?: number;
}

/**
 * Returned once at issue time.
 * privateKeyPem MUST NOT be persisted to the application database.
 * It is stored only in OpenBao KV and returned here for immediate delivery to the client.
 */
export interface IssuedCertResult {
  serialNumber: string;
  fingerprint: string;
  subject: string;
  /** PEM — safe to store in DB */
  certificatePem: string;
  /** PEM — ONLY HERE, never written to the app DB */
  privateKeyPem: string;
  /** PEM — public, safe to store */
  caCertPem: string;
  /** OpenBao KV path where the private key is stored */
  openbaoKeyPath: string;
  notBefore: Date;
  notAfter: Date;
}

/**
 * Bundle retrieved from OpenBao for the download endpoint.
 * privateKeyPem is streamed from OpenBao — never persisted outside OpenBao.
 */
export interface CertBundleResult {
  certificatePem: string;
  /** PEM — retrieved from OpenBao, never stored in app DB */
  privateKeyPem: string;
  caCertPem: string;
}

export interface CertRevocationStatus {
  revoked: boolean;
  /** Populated when revoked=true */
  revokedAt?: Date;
}

export interface CertificateProvider {
  issue(params: IssueCertParams): Promise<IssuedCertResult>;
  /** Revokes the cert in OpenBao PKI by serial number */
  revoke(serialNumber: string): Promise<void>;
  /** Retrieves the private key from OpenBao KV by openbaoKeyPath */
  getBundle(
    openbaoKeyPath: string,
    certificatePem: string,
    caCertPem: string,
  ): Promise<CertBundleResult>;
  /** Removes the private key from OpenBao KV (called after revocation) */
  deleteKey(openbaoKeyPath: string): Promise<void>;
  /**
   * Checks OpenBao PKI for whether a cert serial has been revoked.
   * Catches out-of-band admin revocations that bypass the app-level revoke flow.
   * Fails open (returns {revoked:false}) on any OpenBao connectivity error.
   */
  checkRevocation(serialNumber: string): Promise<CertRevocationStatus>;

  /**
   * Fetches the full CRL from OpenBao PKI and returns all revoked serial numbers.
   *
   * Returns `string[]`  — CRL fetched successfully; may be empty (no revocations).
   * Returns `null`      — CRL unavailable or unparseable; caller should fall back
   *                       to per-cert `checkRevocation()`.
   *
   * Serials are normalized: uppercase hex, no colons, no DER sign byte prefix.
   */
  fetchCrlSerials(): Promise<string[] | null>;
}
