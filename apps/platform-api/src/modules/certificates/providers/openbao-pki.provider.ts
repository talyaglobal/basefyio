import { Inject, Injectable, Logger } from '@nestjs/common';
import { createHash } from 'crypto';
import {
  CertificateProvider,
  CertRevocationStatus,
  IssueCertParams,
  IssuedCertResult,
  CertBundleResult,
} from './certificate-provider.interface';

export const OPENBAO_PKI_CONFIG = 'OPENBAO_PKI_CONFIG';

export interface OpenBaoPkiConfig {
  /** e.g. https://vault.internal:8200 */
  baseUrl: string;
  vaultToken: string;
  /** PKI mount path, e.g. "pki" */
  pkiMount: string;
  /** PKI role name, e.g. "basefyio-client" */
  pkiRole: string;
  /** KV v2 mount for private key storage, e.g. "secret" */
  kvMount: string;
}

/**
 * OpenBao-backed PKI provider.
 *
 * Flow:
 *  1. issue()  → POST /v1/{pkiMount}/issue/{pkiRole}
 *                → POST /v1/{kvMount}/data/certs/{projectId}/{serial} (store key)
 *                → returns IssuedCertResult (privateKeyPem only here)
 *  2. revoke() → POST /v1/{pkiMount}/revoke
 *  3. getBundle() → GET /v1/{kvMount}/data/certs/...
 *  4. deleteKey() → DELETE /v1/{kvMount}/metadata/certs/...
 *
 * Security rules enforced:
 *  - vaultToken never appears in thrown errors or logs.
 *  - privateKeyPem never logged.
 *  - Raw response bodies never propagated — only status strings.
 */
@Injectable()
export class OpenBaoPkiProvider implements CertificateProvider {
  private readonly logger = new Logger(OpenBaoPkiProvider.name);

  constructor(@Inject(OPENBAO_PKI_CONFIG) private readonly cfg: OpenBaoPkiConfig) {}

  async issue(params: IssueCertParams): Promise<IssuedCertResult> {
    const { projectId, accessLevel, ttlDays = 365 } = params;
    const commonName = `project-${projectId}.basefyio.com`;
    const ttl = `${ttlDays * 24}h`;

    const issueUrl = `${this.cfg.baseUrl}/v1/${this.cfg.pkiMount}/issue/${this.cfg.pkiRole}`;
    const issueBody = { common_name: commonName, ttl, format: 'pem' };

    const issueRes = await this.vaultFetch(issueUrl, {
      method: 'POST',
      body: JSON.stringify(issueBody),
    });

    const issued = await this.parseJson<{
      data: {
        certificate: string;
        private_key: string;
        ca_chain: string[];
        serial_number: string;
        expiration: number;
      };
    }>(issueRes, 'issue');

    const certPem: string = issued.data.certificate;
    const privateKeyPem: string = issued.data.private_key;
    const caCertPem: string = issued.data.ca_chain?.[0] ?? '';
    const rawSerial: string = issued.data.serial_number;
    const expirationTs: number = issued.data.expiration;

    const fingerprint = this.fingerprintFromPem(certPem);
    const serialNumber = rawSerial.replace(/:/g, '').toUpperCase();
    const notBefore = new Date();
    const notAfter = new Date(expirationTs * 1000);
    const subject = `CN=${commonName},O=basefyio,accessLevel=${accessLevel}`;

    // Store private key in OpenBao KV v2 — never touches the app DB.
    const kvPath = `certs/${projectId}/${serialNumber}`;
    const kvUrl = `${this.cfg.baseUrl}/v1/${this.cfg.kvMount}/data/${kvPath}`;
    await this.vaultFetch(kvUrl, {
      method: 'POST',
      body: JSON.stringify({ data: { private_key: privateKeyPem } }),
    });

    return {
      serialNumber,
      fingerprint,
      subject,
      certificatePem: certPem,
      privateKeyPem,
      caCertPem,
      openbaoKeyPath: `${this.cfg.kvMount}/data/${kvPath}`,
      notBefore,
      notAfter,
    };
  }

  async revoke(serialNumber: string): Promise<void> {
    const url = `${this.cfg.baseUrl}/v1/${this.cfg.pkiMount}/revoke`;
    // Convert back to colon-separated format for OpenBao
    const colonSerial = serialNumber
      .match(/.{2}/g)
      ?.join(':')
      .toLowerCase() ?? serialNumber;
    await this.vaultFetch(url, {
      method: 'POST',
      body: JSON.stringify({ serial_number: colonSerial }),
    });
  }

  async getBundle(
    openbaoKeyPath: string,
    certificatePem: string,
    caCertPem: string,
  ): Promise<CertBundleResult> {
    // openbaoKeyPath is already the full path e.g. "secret/data/certs/proj/SERIAL"
    const url = `${this.cfg.baseUrl}/v1/${openbaoKeyPath}`;
    const res = await this.vaultFetch(url, { method: 'GET' });
    const body = await this.parseJson<{
      data: { data: { private_key: string } };
    }>(res, 'getBundle');

    const privateKeyPem = body.data?.data?.private_key;
    if (!privateKeyPem) {
      throw new Error('OpenBaoPkiProvider: private key not found at path');
    }

    return { certificatePem, privateKeyPem, caCertPem };
  }

  /**
   * Checks OpenBao PKI for whether a cert serial has been revoked out-of-band.
   * Uses GET /v1/{pkiMount}/cert/{serial} — no CRL parsing required.
   * Fails open (revoked: false) on any network/API error so gateway is never
   * blocked by OpenBao being temporarily unavailable.
   */
  async checkRevocation(serialNumber: string): Promise<CertRevocationStatus> {
    const colonSerial = serialNumber
      .toLowerCase()
      .match(/.{2}/g)
      ?.join(':') ?? serialNumber;

    let res: Response;
    try {
      res = await fetch(
        `${this.cfg.baseUrl}/v1/${this.cfg.pkiMount}/cert/${colonSerial}`,
        { method: 'GET', headers: { 'X-Vault-Token': this.cfg.vaultToken } },
      );
    } catch {
      this.logger.warn(`checkRevocation: OpenBao unreachable for serial ${serialNumber.slice(0, 8)}…`);
      return { revoked: false };
    }

    if (res.status === 404) {
      // Cert not in PKI index — treat as not revoked (may have been pruned)
      return { revoked: false };
    }
    if (!res.ok) {
      this.logger.warn(`checkRevocation: OpenBao returned HTTP ${res.status} for ${serialNumber.slice(0, 8)}…`);
      return { revoked: false };
    }

    let body: { data: { revocation_time: number; revocation_time_rfc3339?: string } };
    try {
      body = (await res.json()) as typeof body;
    } catch {
      this.logger.warn(`checkRevocation: invalid JSON for serial ${serialNumber.slice(0, 8)}…`);
      return { revoked: false };
    }

    const revoked = (body.data?.revocation_time ?? 0) > 0;
    if (!revoked) return { revoked: false };

    const revokedAt = body.data.revocation_time_rfc3339
      ? new Date(body.data.revocation_time_rfc3339)
      : new Date(body.data.revocation_time * 1000);

    return { revoked: true, revokedAt };
  }

  async deleteKey(openbaoKeyPath: string): Promise<void> {
    // KV v2: delete all versions via metadata endpoint
    const metaPath = openbaoKeyPath.replace('/data/', '/metadata/');
    const url = `${this.cfg.baseUrl}/v1/${metaPath}`;
    try {
      await this.vaultFetch(url, { method: 'DELETE' });
    } catch {
      // Non-fatal: log and continue. Key may already be deleted.
      this.logger.warn(`deleteKey: failed to delete KV entry at ${metaPath}`);
    }
  }

  /**
   * Fetches the full CRL from OpenBao and returns all revoked serial numbers
   * as uppercase hex strings (no colons, no DER sign byte).
   *
   * Returns null on any connectivity or parse failure so callers can fail open.
   */
  async fetchCrlSerials(): Promise<string[] | null> {
    const url = `${this.cfg.baseUrl}/v1/${this.cfg.pkiMount}/cert/crl`;
    let res: Response;
    try {
      res = await fetch(url, {
        method: 'GET',
        headers: { 'X-Vault-Token': this.cfg.vaultToken },
      });
    } catch {
      this.logger.warn('fetchCrlSerials: OpenBao unreachable');
      return null;
    }

    if (!res.ok) {
      this.logger.warn(`fetchCrlSerials: OpenBao returned HTTP ${res.status}`);
      return null;
    }

    let body: { data?: { certificate?: string } };
    try {
      body = (await res.json()) as typeof body;
    } catch {
      this.logger.warn('fetchCrlSerials: invalid JSON in CRL response');
      return null;
    }

    const pem = body?.data?.certificate;
    if (!pem) {
      this.logger.warn('fetchCrlSerials: no CRL certificate in response');
      return null;
    }

    try {
      return OpenBaoPkiProvider.parseCrlPemSerials(pem);
    } catch (err) {
      this.logger.warn(`fetchCrlSerials: CRL parse error: ${(err as Error)?.message}`);
      return null;
    }
  }

  /**
   * Parses a PEM-encoded X.509 CRL and returns revoked serial numbers as
   * uppercase hex strings (no colons, no DER sign byte).
   * Exposed as a static method for direct testing.
   * Throws on malformed input so the caller can fail open.
   */
  static parseCrlPemSerials(pem: string): string[] {
    const body = pem
      .replace(/-----BEGIN[^-]+-----/, '')
      .replace(/-----END[^-]+-----/, '')
      .replace(/\s+/g, '');
    if (!body) throw new Error('CRL: empty PEM body');
    const der = Buffer.from(body, 'base64');
    return OpenBaoPkiProvider.extractDerCrlSerials(der);
  }

  /**
   * Minimal DER/ASN.1 CRL parser — extracts only revoked serial numbers.
   * No external dependencies. Handles standard X.509 v1/v2 CRLs.
   *
   * X.509 CRL structure navigated:
   *   CertificateList SEQUENCE
   *     TBSCertList SEQUENCE
   *       [version [0] EXPLICIT INTEGER]   -- optional
   *       signature AlgorithmIdentifier    -- SEQUENCE, skipped
   *       issuer Name                      -- SEQUENCE, skipped
   *       thisUpdate Time                  -- first Time tag seen
   *       [nextUpdate Time]                -- optional
   *       [revokedCertificates SEQUENCE {  -- first SEQUENCE after Time(s)
   *         SEQUENCE { userCertificate INTEGER, revocationDate Time, ... }
   *       }]
   */
  private static extractDerCrlSerials(der: Buffer): string[] {
    const TAG_SEQUENCE = 0x30;
    const TAG_INTEGER = 0x02;
    const TAG_UTC_TIME = 0x17;
    const TAG_GEN_TIME = 0x18;

    function readLen(buf: Buffer, off: number): { len: number; end: number } {
      if (off >= buf.length) throw new Error('CRL: unexpected end of data reading length');
      if (buf[off] < 0x80) return { len: buf[off], end: off + 1 };
      const n = buf[off] & 0x7f;
      if (n === 0 || n > 4) throw new Error('CRL: unsupported length encoding');
      let len = 0;
      for (let i = 1; i <= n; i++) len = (len << 8) | buf[off + i];
      return { len, end: off + 1 + n };
    }

    function tlv(buf: Buffer, off: number) {
      if (off >= buf.length) throw new Error('CRL: unexpected end of data');
      const tag = buf[off];
      const { len, end } = readLen(buf, off + 1);
      if (end + len > buf.length) throw new Error('CRL: TLV length exceeds buffer');
      return { tag, content: buf.subarray(end, end + len), next: end + len };
    }

    function* children(buf: Buffer): Generator<ReturnType<typeof tlv>> {
      let off = 0;
      while (off < buf.length) {
        const item = tlv(buf, off);
        yield item;
        off = item.next;
      }
    }

    // Navigate into CertificateList SEQUENCE → TBSCertList SEQUENCE
    const top = tlv(der, 0);
    if (top.tag !== TAG_SEQUENCE) throw new Error('CRL: top-level SEQUENCE expected');

    let tbsBuf: Buffer | undefined;
    for (const child of children(top.content)) {
      if (child.tag === TAG_SEQUENCE) { tbsBuf = child.content; break; }
    }
    if (!tbsBuf) throw new Error('CRL: TBSCertList not found');

    // Walk TBSCertList children; first SEQUENCE after any Time tag = revokedCertificates
    let timesSeen = 0;
    for (const child of children(tbsBuf)) {
      if (child.tag === TAG_UTC_TIME || child.tag === TAG_GEN_TIME) {
        timesSeen++;
      } else if (child.tag === TAG_SEQUENCE && timesSeen >= 1) {
        const serials: string[] = [];
        for (const entry of children(child.content)) {
          if (entry.tag !== TAG_SEQUENCE) continue;
          const first = tlv(entry.content, 0);
          if (first.tag !== TAG_INTEGER) continue;
          const bytes = first.content;
          // Strip DER positive-integer sign byte (0x00) when present
          const start = bytes.length > 1 && bytes[0] === 0x00 ? 1 : 0;
          serials.push(bytes.subarray(start).toString('hex').toUpperCase());
        }
        return serials;
      }
    }

    return []; // empty CRL — no revokedCertificates section
  }

  // ── Private helpers ───────────────────────────────────────────────────────

  private async vaultFetch(url: string, opts: RequestInit): Promise<Response> {
    let res: Response;
    try {
      res = await fetch(url, {
        ...opts,
        headers: {
          'X-Vault-Token': this.cfg.vaultToken,
          'Content-Type': 'application/json',
          ...(opts.headers ?? {}),
        },
      });
    } catch {
      throw new Error('OpenBaoPkiProvider: could not reach OpenBao (network error)');
    }
    if (!res.ok) {
      throw new Error(`OpenBaoPkiProvider: OpenBao returned HTTP ${res.status}`);
    }
    return res;
  }

  private async parseJson<T>(res: Response, op: string): Promise<T> {
    try {
      return (await res.json()) as T;
    } catch {
      throw new Error(`OpenBaoPkiProvider: invalid JSON in ${op} response`);
    }
  }

  private fingerprintFromPem(pem: string): string {
    const b64 = pem
      .replace(/-----BEGIN CERTIFICATE-----/, '')
      .replace(/-----END CERTIFICATE-----/, '')
      .replace(/\s/g, '');
    const der = Buffer.from(b64, 'base64');
    return createHash('sha256').update(der).digest('hex').toUpperCase();
  }
}
