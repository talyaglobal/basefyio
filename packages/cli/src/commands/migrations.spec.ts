import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Hoisted mocks (must be defined before vi.mock factories run) ──────────────

const { mockApiClient } = vi.hoisted(() => {
  const mockApiClient = {
    planMigration: vi.fn(),
    applyMigration: vi.fn(),
    listMigrations: vi.fn(),
  };
  return { mockApiClient };
});

// ── Module mocks ─────────────────────────────────────────────────────────────

vi.mock('../lib/api.js', () => ({
  apiClient: mockApiClient,
  handleApiError: vi.fn().mockImplementation(async (err) => { throw err; }),
}));

vi.mock('../lib/config.js', () => ({
  getProjectConfig: vi.fn().mockResolvedValue({ projectId: 'proj-123' }),
}));

vi.mock('../lib/ui.js', () => ({
  error: vi.fn(),
  success: vi.fn(),
  info: vi.fn(),
  warning: vi.fn(),
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

import { migrationsPlan, migrationsApply, migrationsList } from './migrations.js';
import { success, info, warning } from '../lib/ui.js';

// ── Fixtures ──────────────────────────────────────────────────────────────────

const PROJECT_ID = 'proj-123';
const RUN_ID = 'run-abc-123';

const BASE_PLAN_RESULT = {
  migrationRunId: RUN_ID,
  fromVersion: 1,
  toVersion: 2,
  plan: {
    operations: [],
    warnings: [],
    breakingChanges: [],
    hasDestructive: false,
  },
  sqlStatements: [],
};

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('migrations CLI commands', () => {
  let consoleSpy: ReturnType<typeof vi.spyOn>;
  let exitSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    exitSpy = vi.spyOn(process, 'exit').mockImplementation((_code?: string | number | null) => {
      throw new Error(`process.exit(${_code})`);
    });
  });

  // ── migrationsPlan ─────────────────────────────────────────────────────────

  describe('migrationsPlan', () => {
    it('prints "no changes" success message and skips apply hint when operations list is empty', async () => {
      mockApiClient.planMigration.mockResolvedValue(BASE_PLAN_RESULT);

      await migrationsPlan();

      expect(mockApiClient.planMigration).toHaveBeenCalledWith(PROJECT_ID, {});
      expect(success).toHaveBeenCalledWith('No changes detected between the two versions');
      // apply hint must NOT be printed when there are no operations
      const allLogs = consoleSpy.mock.calls.map((c: unknown[]) => c[0] ?? '').join('\n');
      expect(allLogs).not.toContain('migrations apply');
    });

    it('prints operation badge and apply hint for SAFE operations', async () => {
      const result = {
        ...BASE_PLAN_RESULT,
        plan: {
          ...BASE_PLAN_RESULT.plan,
          operations: [
            { type: 'CREATE_COLUMN', safety: 'SAFE', collection: 'users', detail: 'Add column bio' },
          ],
        },
        sqlStatements: ['ALTER TABLE users ADD COLUMN bio TEXT;'],
      };
      mockApiClient.planMigration.mockResolvedValue(result);

      await migrationsPlan();

      // Badge line — contains the safety label and detail
      expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('SAFE'));
      expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('Add column bio'));
      // Apply hint — no --force flag for non-destructive plans
      expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining(RUN_ID));
      expect(consoleSpy).not.toHaveBeenCalledWith(expect.stringContaining('--force'));
      expect(info).toHaveBeenCalledWith(expect.stringContaining('Apply this plan'));
    });

    it('prints --force warning and command hint for DESTRUCTIVE operations', async () => {
      const result = {
        ...BASE_PLAN_RESULT,
        plan: {
          ...BASE_PLAN_RESULT.plan,
          operations: [
            { type: 'DROP_COLUMN', safety: 'DESTRUCTIVE', collection: 'users', field: 'age', detail: 'Drop column age' },
          ],
          hasDestructive: true,
        },
        sqlStatements: ['ALTER TABLE users DROP COLUMN age;'],
      };
      mockApiClient.planMigration.mockResolvedValue(result);

      await migrationsPlan();

      expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('DESTRUCTIVE'));
      // warning() from ui.js should fire
      expect(warning).toHaveBeenCalledWith(
        expect.stringContaining('DESTRUCTIVE'),
      );
      // Hint line should include --force
      expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('--force'));
    });

    it('forwards fromVersion / toVersion options to the API', async () => {
      mockApiClient.planMigration.mockResolvedValue(BASE_PLAN_RESULT);

      await migrationsPlan({ fromVersion: 3, toVersion: 5 });

      expect(mockApiClient.planMigration).toHaveBeenCalledWith(PROJECT_ID, {
        fromVersion: 3,
        toVersion: 5,
      });
    });
  });

  // ── migrationsApply ────────────────────────────────────────────────────────

  describe('migrationsApply', () => {
    it('calls apiClient.applyMigration and prints success for APPLIED status', async () => {
      mockApiClient.applyMigration.mockResolvedValue({
        migrationRunId: RUN_ID,
        status: 'APPLIED',
        appliedStatements: 3,
      });

      await migrationsApply(RUN_ID);

      expect(mockApiClient.applyMigration).toHaveBeenCalledWith(PROJECT_ID, RUN_ID, false);
      expect(success).toHaveBeenCalledWith(expect.stringContaining('3'));
      expect(exitSpy).not.toHaveBeenCalled();
    });

    it('prints error message and calls process.exit(1) for FAILED status', async () => {
      mockApiClient.applyMigration.mockResolvedValue({
        migrationRunId: RUN_ID,
        status: 'FAILED',
        appliedStatements: 1,
        errorMessage: 'column "age" of relation "users" does not exist',
      });
      const { error } = await import('../lib/ui.js');

      await expect(migrationsApply(RUN_ID)).rejects.toThrow('process.exit(1)');

      expect(error).toHaveBeenCalledWith(expect.stringContaining('FAILED'));
      // errorMessage should be printed to console
      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining('column "age" of relation "users" does not exist'),
      );
    });

    it('passes force=true to the API when --force option is set', async () => {
      mockApiClient.applyMigration.mockResolvedValue({
        migrationRunId: RUN_ID,
        status: 'APPLIED',
        appliedStatements: 2,
      });

      await migrationsApply(RUN_ID, { force: true });

      expect(mockApiClient.applyMigration).toHaveBeenCalledWith(PROJECT_ID, RUN_ID, true);
    });
  });

  // ── migrationsList ─────────────────────────────────────────────────────────

  describe('migrationsList', () => {
    it('prints info message when no migration runs exist', async () => {
      mockApiClient.listMigrations.mockResolvedValue([]);

      await migrationsList();

      expect(mockApiClient.listMigrations).toHaveBeenCalledWith(PROJECT_ID);
      expect(info).toHaveBeenCalledWith(
        expect.stringContaining('No migration runs found'),
      );
      // Hint to run plan should follow
      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining('migrations plan'),
      );
    });

    it('renders a table row for each migration run returned by the API', async () => {
      const runs = [
        {
          id: 'run-aaa-111',
          fromBlueprintVersion: 1,
          toBlueprintVersion: 2,
          status: 'APPLIED',
          appliedStatements: 4,
          createdAt: '2026-06-01T10:00:00.000Z',
        },
        {
          id: 'run-bbb-222',
          fromBlueprintVersion: 2,
          toBlueprintVersion: 3,
          status: 'FAILED',
          appliedStatements: 0,
          createdAt: '2026-06-02T12:00:00.000Z',
        },
      ];
      mockApiClient.listMigrations.mockResolvedValue(runs);

      await migrationsList();

      // Header row
      expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('ID'));
      expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('Status'));
      // Each run ID appears in the output
      expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('run-aaa-111'));
      expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('run-bbb-222'));
      // Statuses appear
      expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('APPLIED'));
      expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('FAILED'));
    });
  });
});
