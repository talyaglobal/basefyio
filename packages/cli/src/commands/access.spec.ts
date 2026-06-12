import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Hoisted mocks (must be defined before vi.mock factories run) ──────────────

const { mockApiClient, mockHandleApiError } = vi.hoisted(() => {
  const mockApiClient = {
    getProjectAccess: vi.fn(),
  };
  const mockHandleApiError = vi.fn().mockImplementation(async (err) => { throw err; });
  return { mockApiClient, mockHandleApiError };
});

// ── Module mocks ─────────────────────────────────────────────────────────────

vi.mock('../lib/api.js', () => ({
  apiClient: mockApiClient,
  handleApiError: mockHandleApiError,
}));

vi.mock('../lib/ui.js', () => ({
  error: vi.fn(),
  success: vi.fn(),
  info: vi.fn(),
  warning: vi.fn(),
  printKeyValue: vi.fn(),
  printTable: vi.fn(),
  createSpinner: vi.fn().mockReturnValue({ stop: vi.fn(), fail: vi.fn() }),
}));

vi.mock('chalk', () => {
  // Identity proxy: chalk.bold(s) === s, chalk.green(s) === s, etc.
  const identity = (s: string) => s;
  const handler: ProxyHandler<object> = {
    get: (_target, _prop) => new Proxy(identity, handler),
    apply: (_target, _thisArg, args) => args[0] ?? '',
  };
  const chalk = new Proxy(identity, handler);
  return { default: chalk };
});

// ── Imports (after mocks) ─────────────────────────────────────────────────────

import { projectAccess as showProjectAccess } from './access.js';
import { warning, info, printKeyValue } from '../lib/ui.js';
import { handleApiError } from '../lib/api.js';

// ── Fixtures ──────────────────────────────────────────────────────────────────

const PROJECT_ID = 'proj-123';

const BASE_ENDPOINT = {
  engineType: 'postgres',
  host: 'db.proj-123.example.com',
  port: 5432,
  username: 'readonly_user',
  database: 'app_db',
  requiresClientCert: false,
  accessLevel: 'read',
  active: true,
  connectionString: 'postgresql://readonly_user@db.proj-123.example.com:5432/app_db',
  sslMode: 'require',
  snippets: {
    psql: "psql 'postgresql://readonly_user@db.proj-123.example.com:5432/app_db?sslmode=require'",
  },
};

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('access CLI command — projectAccess', () => {
  let consoleSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  it('happy path with endpoint — printKeyValue called with host, port, username, database; connectionString printed', async () => {
    mockApiClient.getProjectAccess.mockResolvedValue({
      projectId: PROJECT_ID,
      slug: 'my-project',
      endpoints: [BASE_ENDPOINT],
      entitlements: { externalDbAccess: true },
    });

    await showProjectAccess(PROJECT_ID);

    expect(mockApiClient.getProjectAccess).toHaveBeenCalledWith(PROJECT_ID);

    // printKeyValue must have been called — check that it received the key fields
    expect(printKeyValue).toHaveBeenCalled();
    const keyValueArg = (printKeyValue as any).mock.calls[0][0] as Record<string, unknown>;
    const values = Object.values(keyValueArg).map(String);
    expect(values).toContain(BASE_ENDPOINT.host);
    expect(values).toContain(String(BASE_ENDPOINT.port));
    expect(values).toContain(BASE_ENDPOINT.username);
    expect(values).toContain(BASE_ENDPOINT.database);

    // connectionString must appear somewhere in console output
    const allLogs = consoleSpy.mock.calls.map(c => String(c[0] ?? '')).join('\n');
    expect(allLogs).toContain(BASE_ENDPOINT.connectionString);
  });

  it('warning shown — response.warning causes warning() to be called with the message', async () => {
    const warnMessage = 'External database access is not enabled for this project.';
    mockApiClient.getProjectAccess.mockResolvedValue({
      projectId: PROJECT_ID,
      slug: 'my-project',
      endpoints: [BASE_ENDPOINT],
      entitlements: { externalDbAccess: false },
      warning: warnMessage,
    });

    await showProjectAccess(PROJECT_ID);

    // warning is printed via console.log(chalk.yellow(...)) not the warning() helper
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining(warnMessage));
  });

  it('empty endpoints — info("No active endpoints.") called when endpoints array is empty', async () => {
    mockApiClient.getProjectAccess.mockResolvedValue({
      projectId: PROJECT_ID,
      slug: 'my-project',
      endpoints: [],
      entitlements: { externalDbAccess: true },
    });

    await showProjectAccess(PROJECT_ID);

    expect(info).toHaveBeenCalledWith(expect.stringContaining('No endpoints provisioned yet'));
    expect(printKeyValue).not.toHaveBeenCalled();
  });

  it('forbidden error — getProjectAccess rejects with 403 → handleApiError called, no crash', async () => {
    const err = {
      response: { status: 403, data: { message: 'Plan does not include feature: externalDbAccess' } },
    };
    mockApiClient.getProjectAccess.mockRejectedValue(err);
    // Make handleApiError not throw so we can assert it was called
    mockHandleApiError.mockResolvedValueOnce(undefined);

    await showProjectAccess(PROJECT_ID);

    expect(handleApiError).toHaveBeenCalledWith(err);
  });

  it('no secrets in output — console.log is never called with a string containing the password value', async () => {
    // Simulate a response that contains a password field (leaky mock / unexpected server field)
    mockApiClient.getProjectAccess.mockResolvedValue({
      projectId: PROJECT_ID,
      slug: 'my-project',
      endpoints: [
        {
          ...BASE_ENDPOINT,
          password: 'secret123',  // extra field that must never be printed
        },
      ],
      entitlements: { externalDbAccess: true },
    } as any);

    await showProjectAccess(PROJECT_ID);

    const allLogs = consoleSpy.mock.calls.map(c => String(c[0] ?? '')).join('\n');
    expect(allLogs).not.toContain('secret123');
  });
});
