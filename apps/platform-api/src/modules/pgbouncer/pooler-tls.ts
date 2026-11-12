import { X509Certificate, createPrivateKey } from 'crypto';
import { rootCertificates } from 'tls';

/**
 * Certificate handling for the pooler's client-facing TLS. Pure functions over
 * PEM text so they can be tested without a pooler or a filesystem.
 */

const PEM_CERT_RE = /-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g;

/** The certificates in a PEM bundle, in file order. */
export function splitPemCertificates(pem: string): string[] {
  return (pem || '').match(PEM_CERT_RE) ?? [];
}

/** Issued by itself and signed by its own key. */
export function isSelfSigned(cert: X509Certificate): boolean {
  try {
    return cert.subject === cert.issuer && cert.verify(cert.publicKey);
  } catch {
    return false;
  }
}

export type PairCheck =
  | { ok: true; leaf: X509Certificate; chain: X509Certificate[] }
  | { ok: false; reason: string };

/**
 * Whether a certificate (with its chain) and a private key can replace the
 * pair the pooler serves: they parse, belong together, and are valid now. A
 * pair that fails is never installed — a broken pair would stop the pooler
 * from loading TLS at its next reload, for every tenant.
 */
export function checkCertificatePair(certPem: string, keyPem: string, now: Date = new Date()): PairCheck {
  const pems = splitPemCertificates(certPem);
  if (!pems.length) return { ok: false, reason: 'no certificate found in the file' };
  let chain: X509Certificate[];
  try {
    chain = pems.map((p) => new X509Certificate(p));
  } catch (err: any) {
    return { ok: false, reason: `certificate could not be read: ${err?.message ?? err}` };
  }
  const leaf = chain[0];
  try {
    const key = createPrivateKey(keyPem);
    if (!leaf.checkPrivateKey(key)) return { ok: false, reason: 'the private key does not belong to the certificate' };
  } catch (err: any) {
    return { ok: false, reason: `private key could not be read: ${err?.message ?? err}` };
  }
  if (new Date(leaf.validFrom) > now) return { ok: false, reason: `certificate is not valid before ${leaf.validFrom}` };
  if (new Date(leaf.validTo) <= now) return { ok: false, reason: `certificate expired on ${leaf.validTo}` };
  return { ok: true, leaf, chain };
}

export interface ClientTrustBundle {
  /** The PEM file a client passes as `sslrootcert`. */
  pem: string;
  /** 'self-signed': the pooler's own certificate. 'public-ca': the root it chains to, plus intermediates. */
  kind: 'self-signed' | 'public-ca';
  /** Who the pooler's certificate is for, and until when. */
  subject: string;
  subjectAltName: string | null;
  validTo: string;
}

/**
 * The file a client needs to verify the pooler (`sslmode=verify-full`).
 *
 * A self-signed certificate is its own trust anchor, so the file is the
 * certificate itself. A certificate from a public authority needs that
 * authority's root, which the pooler does not serve — it is looked up in the
 * root store bundled with Node (the same public roots browsers trust) by
 * issuer and signature, then written out with the intermediates. Null when no
 * root can be found; clients can then rely on their system store instead.
 */
export function clientTrustBundle(
  certPem: string,
  roots: readonly string[] = rootCertificates,
): ClientTrustBundle | null {
  const pems = splitPemCertificates(certPem);
  if (!pems.length) return null;
  let chain: X509Certificate[];
  try {
    chain = pems.map((p) => new X509Certificate(p));
  } catch {
    return null;
  }
  const leaf = chain[0];
  const describe = { subject: leaf.subject, subjectAltName: leaf.subjectAltName ?? null, validTo: leaf.validTo };

  if (isSelfSigned(leaf)) {
    return { pem: ensureNewline(leaf.toString()), kind: 'self-signed', ...describe };
  }

  const intermediates = chain.slice(1).filter((c) => !isSelfSigned(c));
  const servedRoot = chain.slice(1).find((c) => isSelfSigned(c));
  const top = intermediates.length ? intermediates[intermediates.length - 1] : leaf;

  let root: X509Certificate | null = servedRoot && issuedBy(top, servedRoot) ? servedRoot : null;
  if (!root) {
    for (const pem of roots) {
      let candidate: X509Certificate;
      try {
        candidate = new X509Certificate(pem);
      } catch {
        continue;
      }
      if (issuedBy(top, candidate)) {
        root = candidate;
        break;
      }
    }
  }
  if (!root) return null;

  const bundle = [root, ...intermediates].map((c) => ensureNewline(c.toString())).join('');
  return { pem: bundle, kind: 'public-ca', ...describe };
}

function issuedBy(cert: X509Certificate, issuer: X509Certificate): boolean {
  try {
    return cert.checkIssued(issuer) && cert.verify(issuer.publicKey);
  } catch {
    return false;
  }
}

function ensureNewline(s: string): string {
  return s.endsWith('\n') ? s : `${s}\n`;
}
