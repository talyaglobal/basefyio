import type { BasefyioFetchClient } from '../lib/fetch.js';

export interface MigrationPlanResult {
  migrationRunId: string;
  fromVersion: number;
  toVersion: number;
  plan: {
    operations: Array<{
      type: string;
      safety: 'SAFE' | 'DESTRUCTIVE' | 'POTENTIALLY_SAFE';
      collection: string;
      field?: string;
      detail: string;
    }>;
    warnings: string[];
    breakingChanges: string[];
    hasDestructive: boolean;
  };
  sqlStatements: string[];
}

export interface MigrationApplyResult {
  migrationRunId: string;
  status: 'APPLIED' | 'FAILED';
  appliedStatements: number;
  errorMessage?: string;
}

export interface MigrationRun {
  id: string;
  fromBlueprintVersion: number;
  toBlueprintVersion: number;
  status: string;
  appliedStatements: number;
  errorMessage: string | null;
  startedAt: string | null;
  completedAt: string | null;
  createdAt: string;
}

export class MigrationsClient {
  constructor(private readonly http: BasefyioFetchClient) {}

  /**
   * Compute a migration plan between two blueprint versions.
   * If fromVersion/toVersion are omitted, uses the two most recent versions.
   */
  async planMigration(
    projectId: string,
    opts: { fromVersion?: number; toVersion?: number } = {},
  ): Promise<MigrationPlanResult> {
    return this.http.json<MigrationPlanResult>(
      `/v1/projects/${encodeURIComponent(projectId)}/migrations/plan`,
      {
        method: 'POST',
        body: JSON.stringify(opts),
        headers: { 'Content-Type': 'application/json' },
      },
    );
  }

  /**
   * Apply a previously computed migration plan.
   * Set force=true to apply plans containing destructive changes.
   */
  async applyMigration(
    projectId: string,
    migrationRunId: string,
    opts: { force?: boolean } = {},
  ): Promise<MigrationApplyResult> {
    return this.http.json<MigrationApplyResult>(
      `/v1/projects/${encodeURIComponent(projectId)}/migrations/apply`,
      {
        method: 'POST',
        body: JSON.stringify({ migrationRunId, force: opts.force }),
        headers: { 'Content-Type': 'application/json' },
      },
    );
  }

  /** List all migration runs for a project (most recent first). */
  async listMigrations(projectId: string): Promise<MigrationRun[]> {
    return this.http.json<MigrationRun[]>(
      `/v1/projects/${encodeURIComponent(projectId)}/migrations`,
    );
  }

  /** Get a single migration run by ID. */
  async getMigration(projectId: string, migrationRunId: string): Promise<MigrationRun> {
    return this.http.json<MigrationRun>(
      `/v1/projects/${encodeURIComponent(projectId)}/migrations/${encodeURIComponent(migrationRunId)}`,
    );
  }
}
