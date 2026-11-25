import { Injectable, Logger } from '@nestjs/common';
import type { PoolClient } from 'pg';
import { ProjectDatabaseService } from '../projects/project-database.service';
import {
  ADVISOR_RULES,
  AdvisorCategory,
  AdvisorCounts,
  AdvisorFinding,
  AdvisorRule,
  countFindings,
  sortFindings,
} from './advisor-rules';

export interface AdvisorReport {
  generatedAt: string;
  counts: AdvisorCounts;
  findings: AdvisorFinding[];
  /** Rules that could not run (timeout, missing privilege); the rest of the report still holds. */
  skippedRules: { ruleId: string; reason: string }[];
}

/** Per rule; a catalog query that needs longer is skipped rather than load the shared server. */
export const ADVISOR_STATEMENT_TIMEOUT_MS = 5_000;
export const ADVISOR_CACHE_MS = 60_000;

/**
 * Runs the advisor rules against a project database (#218). Read-only: one
 * `BEGIN READ ONLY` transaction that is always rolled back, a statement and lock
 * timeout per rule, and a savepoint per rule so one failing rule does not hide
 * the others. Results are cached for 60 s per project and user.
 */
@Injectable()
export class AdvisorsService {
  private readonly logger = new Logger(AdvisorsService.name);
  private readonly cache = new Map<string, { at: number; report: AdvisorReport }>();

  constructor(private readonly db: ProjectDatabaseService) {}

  async scan(
    projectId: string,
    userId: string,
    opts: { category?: AdvisorCategory; refresh?: boolean } = {},
  ): Promise<AdvisorReport> {
    const key = `${projectId}:${userId}`;
    const hit = this.cache.get(key);
    let report: AdvisorReport;
    if (!opts.refresh && hit && Date.now() - hit.at < ADVISOR_CACHE_MS) {
      report = hit.report;
    } else {
      // withProjectDb checks that the project is active and the user is on its team.
      report = await this.db.withProjectDb(projectId, userId, (client) => runRules(client, ADVISOR_RULES));
      this.cache.set(key, { at: Date.now(), report });
      this.evictStale();
      if (report.skippedRules.length) {
        this.logger.warn(
          `Advisors on project ${projectId} skipped ${report.skippedRules.map((s) => s.ruleId).join(', ')}`,
        );
      }
    }
    return opts.category ? filterReport(report, opts.category) : report;
  }

  private evictStale(): void {
    const now = Date.now();
    for (const [k, v] of this.cache) if (now - v.at >= ADVISOR_CACHE_MS) this.cache.delete(k);
  }
}

export function filterReport(report: AdvisorReport, category: AdvisorCategory): AdvisorReport {
  const findings = report.findings.filter((f) => f.category === category);
  return { ...report, findings, counts: countFindings(findings) };
}

export async function runRules(client: PoolClient, rules: readonly AdvisorRule[]): Promise<AdvisorReport> {
  const findings: AdvisorFinding[] = [];
  const skippedRules: AdvisorReport['skippedRules'] = [];
  await client.query('BEGIN READ ONLY');
  try {
    await client.query(`SET LOCAL statement_timeout = ${ADVISOR_STATEMENT_TIMEOUT_MS}`);
    await client.query(`SET LOCAL lock_timeout = 1000`);
    for (const rule of rules) {
      await client.query('SAVEPOINT advisor_rule');
      try {
        const res = await client.query(rule.sql);
        findings.push(...rule.map(res.rows ?? []));
        await client.query('RELEASE SAVEPOINT advisor_rule');
      } catch (e: any) {
        await client.query('ROLLBACK TO SAVEPOINT advisor_rule');
        skippedRules.push({
          ruleId: rule.id,
          reason: e?.code === '57014' ? 'timed out' : String(e?.message ?? 'failed').slice(0, 200),
        });
      }
    }
  } finally {
    await client.query('ROLLBACK').catch(() => undefined);
  }
  const sorted = sortFindings(findings);
  return { generatedAt: new Date().toISOString(), counts: countFindings(sorted), findings: sorted, skippedRules };
}
