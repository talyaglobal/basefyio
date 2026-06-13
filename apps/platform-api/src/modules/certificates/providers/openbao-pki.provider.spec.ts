import { OpenBaoPkiProvider } from './openbao-pki.provider';

// ── Fixtures ──────────────────────────────────────────────────────────────────

const CFG = {
  baseUrl: 'http://vault.test:8200',
  vaultToken: 'root-token',
  pkiMount: 'pki',
  pkiRole: 'basefyio-client',
  kvMount: 'secret',
};

const SERIAL_HEX = 'AABBCCDDEEFF1122';
const SERIAL_COLON = 'aa:bb:cc:dd:ee:ff:11:22';

function makeProvider() {
  return new OpenBaoPkiProvider(CFG);
}

function mockFetch(status: number, body: unknown, networkError = false) {
  const fetchMock = networkError
    ? jest.fn().mockRejectedValue(new TypeError('fetch failed'))
    : jest.fn().mockResolvedValue({
        ok: status >= 200 && status < 300,
        status,
        json: jest.fn().mockResolvedValue(body),
      });
  global.fetch = fetchMock as any;
  return fetchMock;
}

// ── checkRevocation() ─────────────────────────────────────────────────────────

describe('OpenBaoPkiProvider.checkRevocation()', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('returns revoked=false for an active (non-revoked) cert', async () => {
    mockFetch(200, { data: { revocation_time: 0, revocation_time_rfc3339: '' } });
    const result = await makeProvider().checkRevocation(SERIAL_HEX);
    expect(result).toEqual({ revoked: false });
  });

  it('returns revoked=true with revokedAt when cert is revoked', async () => {
    mockFetch(200, {
      data: {
        revocation_time: 1_748_000_000,
        revocation_time_rfc3339: '2025-05-23T04:53:20Z',
      },
    });
    const result = await makeProvider().checkRevocation(SERIAL_HEX);
    expect(result.revoked).toBe(true);
    expect(result.revokedAt).toEqual(new Date('2025-05-23T04:53:20Z'));
  });

  it('uses revocation_time epoch as fallback when rfc3339 is absent', async () => {
    const ts = 1_748_000_000;
    mockFetch(200, { data: { revocation_time: ts } });
    const result = await makeProvider().checkRevocation(SERIAL_HEX);
    expect(result.revoked).toBe(true);
    expect(result.revokedAt).toEqual(new Date(ts * 1000));
  });

  it('converts uppercase hex serial to colon-separated for the URL', async () => {
    const fetchMock = mockFetch(200, { data: { revocation_time: 0 } });
    await makeProvider().checkRevocation(SERIAL_HEX);
    const url: string = fetchMock.mock.calls[0][0];
    expect(url).toContain(`/pki/cert/${SERIAL_COLON}`);
  });

  it('includes X-Vault-Token header', async () => {
    const fetchMock = mockFetch(200, { data: { revocation_time: 0 } });
    await makeProvider().checkRevocation(SERIAL_HEX);
    const headers: Record<string, string> = fetchMock.mock.calls[0][1].headers;
    expect(headers['X-Vault-Token']).toBe(CFG.vaultToken);
  });

  it('fails open (revoked=false) on network error', async () => {
    mockFetch(0, null, true);
    const result = await makeProvider().checkRevocation(SERIAL_HEX);
    expect(result).toEqual({ revoked: false });
  });

  it('fails open on HTTP 404 (cert not in PKI index)', async () => {
    mockFetch(404, { errors: [] });
    const result = await makeProvider().checkRevocation(SERIAL_HEX);
    expect(result).toEqual({ revoked: false });
  });

  it('fails open on HTTP 500', async () => {
    mockFetch(500, { errors: ['internal server error'] });
    const result = await makeProvider().checkRevocation(SERIAL_HEX);
    expect(result).toEqual({ revoked: false });
  });

  it('fails open on malformed JSON response', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: jest.fn().mockRejectedValue(new SyntaxError('Unexpected token')),
    }) as any;
    const result = await makeProvider().checkRevocation(SERIAL_HEX);
    expect(result).toEqual({ revoked: false });
  });

  it('never logs the vault token in warn/error output', async () => {
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    mockFetch(0, null, true); // trigger a warn
    await makeProvider().checkRevocation(SERIAL_HEX);
    for (const call of [...warnSpy.mock.calls, ...errorSpy.mock.calls]) {
      expect(JSON.stringify(call)).not.toContain(CFG.vaultToken);
    }
    warnSpy.mockRestore();
    errorSpy.mockRestore();
  });
});

// ── DER CRL builder (test-only) ───────────────────────────────────────────────

function derLen(n: number): Buffer {
  if (n < 0x80) return Buffer.from([n]);
  if (n < 0x100) return Buffer.from([0x81, n]);
  return Buffer.from([0x82, (n >> 8) & 0xff, n & 0xff]);
}

function derTlv(tag: number, content: Buffer): Buffer {
  return Buffer.concat([Buffer.from([tag]), derLen(content.length), content]);
}

function derSeq(...items: Buffer[]): Buffer {
  return derTlv(0x30, Buffer.concat(items));
}

function derInt(bytes: Buffer): Buffer {
  const needsPad = bytes.length > 0 && (bytes[0] & 0x80) !== 0;
  const content = needsPad ? Buffer.concat([Buffer.from([0x00]), bytes]) : bytes;
  return derTlv(0x02, content);
}

function derUtcTime(): Buffer {
  return derTlv(0x17, Buffer.from('260101000000Z', 'ascii'));
}

/**
 * Builds a minimal but structurally valid DER X.509 CRL and PEM-encodes it.
 * Structure: CertificateList { TBSCertList { dummy SEQUENCE, UTCTime, [revokedCerts] } }
 * revokedSerials: raw byte values WITHOUT the DER sign byte (add high-bit bytes to test stripping).
 */
function buildCrlPem(revokedSerials: Buffer[]): string {
  const time = derUtcTime();
  const revokedEntries = revokedSerials.map((s) => derSeq(derInt(s), time));
  const revokedSeq = derSeq(...revokedEntries);
  const tbsCertList =
    revokedSerials.length > 0
      ? derSeq(derSeq(), time, revokedSeq)
      : derSeq(derSeq(), time);
  const crl = derSeq(tbsCertList, derSeq(), derTlv(0x03, Buffer.from([0x00])));
  const b64 = crl.toString('base64');
  return `-----BEGIN X509 CRL-----\n${b64}\n-----END X509 CRL-----`;
}

// ── fetchCrlSerials() ─────────────────────────────────────────────────────────

describe('OpenBaoPkiProvider.fetchCrlSerials()', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('success — returns parsed serial list from valid CRL', async () => {
    const serial = Buffer.from([0x0a, 0xbb, 0xcc]);
    const pem = buildCrlPem([serial]);
    mockFetch(200, { data: { certificate: pem } });
    const result = await makeProvider().fetchCrlSerials();
    expect(result).toEqual(['0ABBCC']);
  });

  it('success — empty CRL (no revocations) returns []', async () => {
    const pem = buildCrlPem([]);
    mockFetch(200, { data: { certificate: pem } });
    const result = await makeProvider().fetchCrlSerials();
    expect(result).toEqual([]);
  });

  it('success — multiple serials all returned', async () => {
    const s1 = Buffer.from([0x01, 0x02]);
    const s2 = Buffer.from([0x03, 0x04]);
    const s3 = Buffer.from([0x05, 0x06]);
    const pem = buildCrlPem([s1, s2, s3]);
    mockFetch(200, { data: { certificate: pem } });
    const result = await makeProvider().fetchCrlSerials();
    expect(result).toEqual(['0102', '0304', '0506']);
  });

  it('sign byte stripping — high-bit serial serialized with 0x00 prefix, stripped in output', async () => {
    // 0xFF has high bit set → DER integer gets 0x00 prefix in DER → parser strips it
    const serial = Buffer.from([0xff, 0xee]);
    const pem = buildCrlPem([serial]);
    mockFetch(200, { data: { certificate: pem } });
    const result = await makeProvider().fetchCrlSerials();
    expect(result).toEqual(['FFEE']);
  });

  it('hits the correct URL: /v1/{pkiMount}/cert/crl', async () => {
    const fetchMock = mockFetch(200, { data: { certificate: buildCrlPem([]) } });
    await makeProvider().fetchCrlSerials();
    const url: string = fetchMock.mock.calls[0][0];
    expect(url).toBe(`${CFG.baseUrl}/v1/${CFG.pkiMount}/cert/crl`);
  });

  it('sends X-Vault-Token header', async () => {
    const fetchMock = mockFetch(200, { data: { certificate: buildCrlPem([]) } });
    await makeProvider().fetchCrlSerials();
    const headers: Record<string, string> = fetchMock.mock.calls[0][1].headers;
    expect(headers['X-Vault-Token']).toBe(CFG.vaultToken);
  });

  it('returns null on network error (fail-open)', async () => {
    mockFetch(0, null, true);
    const result = await makeProvider().fetchCrlSerials();
    expect(result).toBeNull();
  });

  it('returns null on HTTP 500', async () => {
    mockFetch(500, { errors: ['internal'] });
    const result = await makeProvider().fetchCrlSerials();
    expect(result).toBeNull();
  });

  it('returns null on malformed JSON', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: jest.fn().mockRejectedValue(new SyntaxError('Unexpected token')),
    }) as any;
    const result = await makeProvider().fetchCrlSerials();
    expect(result).toBeNull();
  });

  it('returns null when data.certificate is absent', async () => {
    mockFetch(200, { data: {} });
    const result = await makeProvider().fetchCrlSerials();
    expect(result).toBeNull();
  });

  it('returns null on malformed PEM (not valid base64)', async () => {
    mockFetch(200, { data: { certificate: '-----BEGIN X509 CRL-----\n!!!NOT_BASE64!!!\n-----END X509 CRL-----' } });
    const result = await makeProvider().fetchCrlSerials();
    expect(result).toBeNull();
  });

  it('never logs vault token on failure', async () => {
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    mockFetch(0, null, true);
    await makeProvider().fetchCrlSerials();
    for (const call of warnSpy.mock.calls) {
      expect(JSON.stringify(call)).not.toContain(CFG.vaultToken);
    }
    warnSpy.mockRestore();
  });
});

// ── parseCrlPemSerials() ──────────────────────────────────────────────────────

describe('OpenBaoPkiProvider.parseCrlPemSerials()', () => {
  it('parses a single-serial CRL', () => {
    const pem = buildCrlPem([Buffer.from([0x12, 0x34])]);
    expect(OpenBaoPkiProvider.parseCrlPemSerials(pem)).toEqual(['1234']);
  });

  it('returns [] for an empty CRL', () => {
    const pem = buildCrlPem([]);
    expect(OpenBaoPkiProvider.parseCrlPemSerials(pem)).toEqual([]);
  });

  it('normalizes serials to uppercase hex without colons', () => {
    const pem = buildCrlPem([Buffer.from([0xab, 0xcd, 0xef])]);
    const result = OpenBaoPkiProvider.parseCrlPemSerials(pem);
    expect(result).toEqual(['ABCDEF']);
    expect(result[0]).not.toContain(':');
  });

  it('throws on empty PEM body', () => {
    expect(() =>
      OpenBaoPkiProvider.parseCrlPemSerials(
        '-----BEGIN X509 CRL-----\n-----END X509 CRL-----',
      ),
    ).toThrow('CRL: empty PEM body');
  });

  it('throws on truncated DER (tag with length beyond buffer)', () => {
    // Single byte of DER — tag byte with no length
    const truncated = `-----BEGIN X509 CRL-----\n${Buffer.from([0x30]).toString('base64')}\n-----END X509 CRL-----`;
    expect(() => OpenBaoPkiProvider.parseCrlPemSerials(truncated)).toThrow();
  });
});
