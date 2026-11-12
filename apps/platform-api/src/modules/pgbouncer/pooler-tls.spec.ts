import { spawnSync } from 'child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { X509Certificate } from 'crypto';
import { checkCertificatePair, clientTrustBundle, isSelfSigned, splitPemCertificates } from './pooler-tls';

/**
 * Real certificates, made with the openssl binary for this run only (no key
 * material lives in the repository): a root, an intermediate it signs, a
 * wildcard leaf the intermediate signs, and an unrelated self-signed pair.
 */
function makeFixtures(dir: string) {
  const ssl = (...args: string[]) => {
    const r = spawnSync(process.env.OPENSSL_BIN || 'openssl', args, { cwd: dir, encoding: 'utf-8' });
    if (r.error || r.status !== 0) throw new Error(`openssl ${args[0]} failed: ${r.error?.message ?? r.stderr}`);
  };
  const ec = ['-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes'];
  writeFileSync(join(dir, 'ca.ext'), 'basicConstraints=critical,CA:TRUE\nkeyUsage=critical,keyCertSign,cRLSign\n');
  writeFileSync(join(dir, 'leaf.ext'), 'basicConstraints=CA:FALSE\nsubjectAltName=DNS:*.example.test,DNS:example.test\n');

  ssl('req', '-x509', ...ec, '-keyout', 'root.key', '-out', 'root.crt', '-days', '3650', '-subj', '/CN=Test Root',
    '-addext', 'basicConstraints=critical,CA:TRUE', '-addext', 'keyUsage=critical,keyCertSign,cRLSign');
  ssl('req', '-new', ...ec, '-keyout', 'int.key', '-out', 'int.csr', '-subj', '/CN=Test Intermediate');
  ssl('x509', '-req', '-in', 'int.csr', '-CA', 'root.crt', '-CAkey', 'root.key', '-CAcreateserial', '-out', 'int.crt',
    '-days', '3650', '-extfile', 'ca.ext');
  ssl('req', '-new', ...ec, '-keyout', 'leaf.key', '-out', 'leaf.csr', '-subj', '/CN=*.example.test');
  ssl('x509', '-req', '-in', 'leaf.csr', '-CA', 'int.crt', '-CAkey', 'int.key', '-CAcreateserial', '-out', 'leaf.crt',
    '-days', '90', '-extfile', 'leaf.ext');
  ssl('req', '-x509', ...ec, '-keyout', 'self.key', '-out', 'self.crt', '-days', '3650', '-subj', '/CN=db.example.test');

  const read = (f: string) => readFileSync(join(dir, f), 'utf-8');
  return {
    root: read('root.crt'),
    intermediate: read('int.crt'),
    leaf: read('leaf.crt'),
    leafKey: read('leaf.key'),
    fullchain: read('leaf.crt') + read('int.crt'),
    self: read('self.crt'),
    selfKey: read('self.key'),
  };
}

const opensslAvailable = (() => {
  const r = spawnSync(process.env.OPENSSL_BIN || 'openssl', ['version'], { encoding: 'utf-8' });
  return !r.error && r.status === 0;
})();

// Without an openssl binary (some Windows shells) the certificate tests cannot
// build their fixtures; they run wherever openssl is on PATH, CI included.
const describeWithOpenssl = opensslAvailable ? describe : describe.skip;

describe('splitPemCertificates', () => {
  it('finds nothing in an empty or non-PEM string', () => {
    expect(splitPemCertificates('')).toEqual([]);
    expect(splitPemCertificates('not a certificate')).toEqual([]);
  });
});

describeWithOpenssl('pooler certificates', () => {
  let dir: string;
  let f: ReturnType<typeof makeFixtures>;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'pooler-tls-'));
    f = makeFixtures(dir);
  });

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('splits a full chain in order', () => {
    const certs = splitPemCertificates(f.fullchain);
    expect(certs).toHaveLength(2);
    expect(new X509Certificate(certs[0]).subject).toContain('*.example.test');
    expect(new X509Certificate(certs[1]).subject).toContain('Test Intermediate');
  });

  it('tells a self-signed certificate from an issued one', () => {
    expect(isSelfSigned(new X509Certificate(f.self))).toBe(true);
    expect(isSelfSigned(new X509Certificate(f.root))).toBe(true);
    expect(isSelfSigned(new X509Certificate(f.leaf))).toBe(false);
  });

  describe('checkCertificatePair', () => {
    it('accepts a matching, current pair', () => {
      const r = checkCertificatePair(f.fullchain, f.leafKey);
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.chain).toHaveLength(2);
    });

    it('refuses a key that belongs to another certificate', () => {
      expect(checkCertificatePair(f.fullchain, f.selfKey)).toMatchObject({ ok: false, reason: expect.stringContaining('does not belong') });
    });

    it('refuses an expired or not-yet-valid certificate', () => {
      expect(checkCertificatePair(f.fullchain, f.leafKey, new Date(Date.now() + 400 * 86_400_000))).toMatchObject({
        ok: false,
        reason: expect.stringContaining('expired'),
      });
      expect(checkCertificatePair(f.fullchain, f.leafKey, new Date(Date.now() - 400 * 86_400_000))).toMatchObject({
        ok: false,
        reason: expect.stringContaining('not valid before'),
      });
    });

    it('refuses files that are not a certificate and a key', () => {
      expect(checkCertificatePair('nothing', f.leafKey).ok).toBe(false);
      expect(checkCertificatePair(f.fullchain, 'nothing').ok).toBe(false);
    });
  });

  describe('clientTrustBundle', () => {
    it('hands out a self-signed certificate as its own trust anchor', () => {
      const b = clientTrustBundle(f.self, []);
      expect(b).toMatchObject({ kind: 'self-signed' });
      expect(new X509Certificate(b!.pem).fingerprint256).toBe(new X509Certificate(f.self).fingerprint256);
    });

    it('finds the root a served chain leads to and bundles it with the intermediate, never the leaf', () => {
      const b = clientTrustBundle(f.fullchain, ['garbage', f.self, f.root]);
      expect(b).toMatchObject({ kind: 'public-ca', subjectAltName: expect.stringContaining('*.example.test') });
      const fingerprints = splitPemCertificates(b!.pem).map((p) => new X509Certificate(p).fingerprint256);
      expect(fingerprints).toEqual([
        new X509Certificate(f.root).fingerprint256,
        new X509Certificate(f.intermediate).fingerprint256,
      ]);
    });

    it('uses a root the server serves itself', () => {
      const b = clientTrustBundle(f.fullchain + f.root, []);
      expect(b?.kind).toBe('public-ca');
      expect(splitPemCertificates(b!.pem)).toHaveLength(2);
    });

    it('gives up when no known root issued the chain', () => {
      expect(clientTrustBundle(f.fullchain, [f.self])).toBeNull();
      expect(clientTrustBundle('nothing')).toBeNull();
    });
  });
});
