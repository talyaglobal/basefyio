import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron } from '@nestjs/schedule';
import { PrismaService } from '../../prisma/prisma.service';
import { PlatformAlertsService } from './platform-alerts.service';

/** Consecutive failing checks (5 minutes apart) before the alert is raised. */
const FAILING_RUNS_BEFORE_ALERT = 2;
/** WAL a slot may hold back before it counts as lagging (the hard cap is max_slot_wal_keep_size). */
const MAX_RETAINED_BYTES = 8 * 1024 ** 3;

export interface SlotRow {
  slot_name: string;
  active: boolean;
  wal_status: string | null;
  retained_bytes: string | number | null;
}

/** What is wrong with the expected standby slots, in plain sentences; empty when healthy. */
export function standbyProblems(expected: string[], rows: SlotRow[], maxRetained = MAX_RETAINED_BYTES): string[] {
  const problems: string[] = [];
  for (const name of expected) {
    const row = rows.find((r) => r.slot_name === name);
    if (!row) {
      problems.push(`${name}: replication slot is missing`);
      continue;
    }
    if (!row.active) problems.push(`${name}: standby is not connected`);
    if (row.wal_status === 'lost') problems.push(`${name}: the standby fell too far behind and must be rebuilt`);
    else if (row.wal_status === 'unreserved') problems.push(`${name}: WAL is about to be removed before the standby read it`);
    const retained = Number(row.retained_bytes ?? 0);
    if (retained > maxRetained) {
      problems.push(`${name}: ${(retained / 1024 ** 3).toFixed(1)} GB of WAL not yet replayed`);
    }
  }
  return problems;
}

/**
 * Watches the Postgres standby (#229). The slots named in PG_STANDBY_SLOTS
 * must exist, be connected and keep up; two failing checks in a row raise a
 * critical alert. Without the variable nothing is checked (self-host, or no
 * standby yet). Reads only pg_replication_slots, which needs no privilege.
 */
@Injectable()
export class StandbyProbeService {
  private readonly logger = new Logger(StandbyProbeService.name);
  private failingRuns = 0;

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly alerts: PlatformAlertsService,
  ) {}

  private expectedSlots(): string[] {
    return String(this.config.get<string>('PG_STANDBY_SLOTS') ?? process.env.PG_STANDBY_SLOTS ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter((s) => /^[a-z0-9_]{1,63}$/.test(s));
  }

  @Cron('*/5 * * * *')
  async run(): Promise<string[]> {
    const expected = this.expectedSlots();
    if (expected.length === 0) return [];
    let problems: string[];
    try {
      const rows = await this.prisma.$queryRaw<SlotRow[]>`
        SELECT slot_name, active, wal_status,
               pg_wal_lsn_diff(pg_current_wal_lsn(), restart_lsn)::bigint::text AS retained_bytes
        FROM pg_replication_slots WHERE slot_type = 'physical'`;
      problems = standbyProblems(expected, rows);
    } catch (err: any) {
      problems = [`check failed: ${err?.message ?? err}`];
    }

    if (problems.length === 0) {
      this.failingRuns = 0;
      return [];
    }
    this.failingRuns += 1;
    this.logger.warn(`Postgres standby unhealthy (${this.failingRuns}): ${problems.join(' | ')}`);
    if (this.failingRuns >= FAILING_RUNS_BEFORE_ALERT) {
      await this.alerts.raise({
        kind: 'pg_standby_unhealthy',
        severity: 'critical',
        title: 'The Postgres standby is not keeping up',
        detail:
          `${problems.join('; ')}. Until it is fixed there is no up-to-date copy to fail over to, ` +
          'and the primary keeps WAL for it (capped by max_slot_wal_keep_size).',
        metadata: { problems },
      });
    }
    return problems;
  }
}
