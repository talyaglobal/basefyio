import { OpenBaoHealthService } from './openbao-health.service';

// ── Fixtures ──────────────────────────────────────────────────────────────────

const CFG = {
  baseUrl: 'http://vault.test:8200',
  vaultToken: 'root-secret-token',
  pkiMount: 'pki',
  pkiRole: 'basefyio-client',
  kvMount: 'secret',
};

function makeService() {
  return new OpenBaoHealthService(CFG);
}

type FetchResponse = { status: number; ok: boolean; json?: () => Promise<unknown> };

function mockFetch(responses: Record<string, FetchResponse | 'network-error'>) {
  global.fetch = jest.fn().mockImplementation(async (url: string) => {
    const key = Object.keys(responses).find((k) => url.includes(k));
    const resp = key ? responses[key] : { status: 200, ok: true };
    if (resp === 'network-error') throw new TypeError('fetch failed');
    return { ...resp, json: resp.json ?? jest.fn().mockResolvedValue({}) };
  });
}

// ── Overall status rollup ─────────────────────────────────────────────────────

describe('OpenBaoHealthService.check() — status rollup', () => {
  afterEach(() => jest.restoreAllMocks());

  it('returns healthy when all components are ok', async () => {
    mockFetch({
      '/sys/health': { status: 200, ok: true },
      '/pki/ca/pem': { status: 200, ok: true },
      '/secret/config': { status: 200, ok: true },
    });
    const report = await makeService().check();
    expect(report.status).toBe('healthy');
    expect(report.components.system.status).toBe('ok');
    expect(report.components.pkiMount.status).toBe('ok');
    expect(report.components.kvMount.status).toBe('ok');
  });

  it('returns degraded when one component is degraded', async () => {
    mockFetch({
      '/sys/health': { status: 200, ok: true },
      '/pki/ca/pem': { status: 404, ok: false },
      '/secret/config': { status: 200, ok: true },
    });
    const report = await makeService().check();
    expect(report.status).toBe('degraded');
    expect(report.components.pkiMount.status).toBe('degraded');
  });

  it('returns unavailable when any component is unavailable', async () => {
    mockFetch({
      '/sys/health': { status: 200, ok: true },
      '/pki/ca/pem': 'network-error',
      '/secret/config': { status: 200, ok: true },
    });
    const report = await makeService().check();
    expect(report.status).toBe('unavailable');
  });

  it('includes a checkedAt ISO timestamp', async () => {
    mockFetch({
      '/sys/health': { status: 200, ok: true },
      '/pki/ca/pem': { status: 200, ok: true },
      '/secret/config': { status: 200, ok: true },
    });
    const report = await makeService().check();
    expect(() => new Date(report.checkedAt)).not.toThrow();
    expect(report.checkedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('runs all three checks in parallel (all fetch calls made regardless of first result)', async () => {
    let callCount = 0;
    global.fetch = jest.fn().mockImplementation(async () => {
      callCount++;
      return { status: 200, ok: true, json: jest.fn().mockResolvedValue({}) };
    });
    await makeService().check();
    expect(callCount).toBe(3);
  });
});

// ── System component ──────────────────────────────────────────────────────────

describe('OpenBaoHealthService — system component', () => {
  afterEach(() => jest.restoreAllMocks());

  it('200 → ok', async () => {
    mockFetch({ '/sys/health': { status: 200, ok: true }, '/pki/ca/pem': { status: 200, ok: true }, '/secret/config': { status: 200, ok: true } });
    const { components } = await makeService().check();
    expect(components.system.status).toBe('ok');
    expect(components.system.detail).toBeUndefined();
  });

  it('429 (standby) → degraded with hint', async () => {
    mockFetch({ '/sys/health': { status: 429, ok: false }, '/pki/ca/pem': { status: 200, ok: true }, '/secret/config': { status: 200, ok: true } });
    const { components } = await makeService().check();
    expect(components.system.status).toBe('degraded');
    expect(components.system.detail).toMatch(/standby/i);
    expect(components.system.hint).toBeDefined();
  });

  it('503 (sealed) → unavailable with hint', async () => {
    mockFetch({ '/sys/health': { status: 503, ok: false }, '/pki/ca/pem': { status: 200, ok: true }, '/secret/config': { status: 200, ok: true } });
    const { components } = await makeService().check();
    expect(components.system.status).toBe('unavailable');
    expect(components.system.detail).toMatch(/sealed/i);
    expect(components.system.hint).toMatch(/unseal/i);
  });

  it('501 (uninitialized) → unavailable with hint', async () => {
    mockFetch({ '/sys/health': { status: 501, ok: false }, '/pki/ca/pem': { status: 200, ok: true }, '/secret/config': { status: 200, ok: true } });
    const { components } = await makeService().check();
    expect(components.system.status).toBe('unavailable');
    expect(components.system.detail).toMatch(/not initialized/i);
    expect(components.system.hint).toMatch(/init/i);
  });

  it('network error → unavailable with hint', async () => {
    mockFetch({ '/sys/health': 'network-error', '/pki/ca/pem': { status: 200, ok: true }, '/secret/config': { status: 200, ok: true } });
    const { components } = await makeService().check();
    expect(components.system.status).toBe('unavailable');
    expect(components.system.detail).toMatch(/unreachable/i);
    expect(components.system.hint).toBeDefined();
  });

  it('unexpected status → degraded', async () => {
    mockFetch({ '/sys/health': { status: 418, ok: false }, '/pki/ca/pem': { status: 200, ok: true }, '/secret/config': { status: 200, ok: true } });
    const { components } = await makeService().check();
    expect(components.system.status).toBe('degraded');
    expect(components.system.detail).toContain('418');
  });
});

// ── PKI mount component ───────────────────────────────────────────────────────

describe('OpenBaoHealthService — pkiMount component', () => {
  afterEach(() => jest.restoreAllMocks());

  it('200 → ok', async () => {
    mockFetch({ '/sys/health': { status: 200, ok: true }, '/pki/ca/pem': { status: 200, ok: true }, '/secret/config': { status: 200, ok: true } });
    const { components } = await makeService().check();
    expect(components.pkiMount.status).toBe('ok');
  });

  it('404 → degraded with hint about enabling PKI', async () => {
    mockFetch({ '/sys/health': { status: 200, ok: true }, '/pki/ca/pem': { status: 404, ok: false }, '/secret/config': { status: 200, ok: true } });
    const { components } = await makeService().check();
    expect(components.pkiMount.status).toBe('degraded');
    expect(components.pkiMount.hint).toMatch(/vault secrets enable/i);
  });

  it('403 → degraded with hint about token permissions', async () => {
    mockFetch({ '/sys/health': { status: 200, ok: true }, '/pki/ca/pem': { status: 403, ok: false }, '/secret/config': { status: 200, ok: true } });
    const { components } = await makeService().check();
    expect(components.pkiMount.status).toBe('degraded');
    expect(components.pkiMount.hint).toMatch(/token/i);
  });

  it('network error → unavailable', async () => {
    mockFetch({ '/sys/health': { status: 200, ok: true }, '/pki/ca/pem': 'network-error', '/secret/config': { status: 200, ok: true } });
    const { components } = await makeService().check();
    expect(components.pkiMount.status).toBe('unavailable');
  });
});

// ── KV mount component ────────────────────────────────────────────────────────

describe('OpenBaoHealthService — kvMount component', () => {
  afterEach(() => jest.restoreAllMocks());

  it('200 → ok', async () => {
    mockFetch({ '/sys/health': { status: 200, ok: true }, '/pki/ca/pem': { status: 200, ok: true }, '/secret/config': { status: 200, ok: true } });
    const { components } = await makeService().check();
    expect(components.kvMount.status).toBe('ok');
  });

  it('404 → degraded with hint about enabling KV', async () => {
    mockFetch({ '/sys/health': { status: 200, ok: true }, '/pki/ca/pem': { status: 200, ok: true }, '/secret/config': { status: 404, ok: false } });
    const { components } = await makeService().check();
    expect(components.kvMount.status).toBe('degraded');
    expect(components.kvMount.hint).toMatch(/vault secrets enable/i);
  });

  it('403 → degraded with hint about token permissions', async () => {
    mockFetch({ '/sys/health': { status: 200, ok: true }, '/pki/ca/pem': { status: 200, ok: true }, '/secret/config': { status: 403, ok: false } });
    const { components } = await makeService().check();
    expect(components.kvMount.status).toBe('degraded');
    expect(components.kvMount.hint).toMatch(/token/i);
  });

  it('network error → unavailable', async () => {
    mockFetch({ '/sys/health': { status: 200, ok: true }, '/pki/ca/pem': { status: 200, ok: true }, '/secret/config': 'network-error' });
    const { components } = await makeService().check();
    expect(components.kvMount.status).toBe('unavailable');
  });
});

// ── Security invariant: no token leakage ─────────────────────────────────────

describe('OpenBaoHealthService — token/credential leakage', () => {
  afterEach(() => jest.restoreAllMocks());

  it('vault token never appears in returned report', async () => {
    mockFetch({ '/sys/health': { status: 200, ok: true }, '/pki/ca/pem': { status: 200, ok: true }, '/secret/config': { status: 200, ok: true } });
    const report = await makeService().check();
    expect(JSON.stringify(report)).not.toContain(CFG.vaultToken);
  });

  it('vault token never appears in report when system is unavailable', async () => {
    mockFetch({ '/sys/health': 'network-error', '/pki/ca/pem': { status: 403, ok: false }, '/secret/config': { status: 503, ok: false } });
    const report = await makeService().check();
    expect(JSON.stringify(report)).not.toContain(CFG.vaultToken);
  });

  it('base URL never appears in returned component details', async () => {
    mockFetch({ '/sys/health': { status: 503, ok: false }, '/pki/ca/pem': { status: 404, ok: false }, '/secret/config': { status: 403, ok: false } });
    const report = await makeService().check();
    const json = JSON.stringify(report);
    expect(json).not.toContain('vault.test');
    expect(json).not.toContain('8200');
  });

  it('malformed response — vault token not logged', async () => {
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    mockFetch({ '/sys/health': { status: 200, ok: true }, '/pki/ca/pem': { status: 200, ok: true }, '/secret/config': { status: 500, ok: false } });
    await makeService().check();
    for (const call of [...warnSpy.mock.calls, ...errorSpy.mock.calls]) {
      expect(JSON.stringify(call)).not.toContain(CFG.vaultToken);
    }
  });
});
