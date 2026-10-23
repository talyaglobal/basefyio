import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma } from '@prisma/client';
import { randomUUID } from 'crypto';
import * as fs from 'fs/promises';
import * as path from 'path';
import { PrismaService } from '../../prisma/prisma.service';

/**
 * Alerts for the platform operator, shown in the root console as a red badge.
 *
 * Two kinds feed it. Events happened once and stay until a root user
 * acknowledges them: an automatic volume growth, a restore refused for lack of
 * disk. Conditions are true right now and clear themselves: a disk past its
 * critical threshold, an autopilot that has stopped reporting.
 *
 * Most events come from the host storage autopilot, which cannot reach the
 * database when the disk is full — exactly when it matters. It appends to a
 * log file on the system disk instead, and this service imports that log into
 * `platform_alerts` whenever the console asks, idempotently by event id.
 */

export type AlertSeverity = 'critical' | 'warning';

export interface ConsoleAlert {
  id: string;
  source: string;
  kind: string;
  severity: AlertSeverity;
  title: string;
  detail: string | null;
  metadata: unknown;
  occurredAt: string;
}

export interface ConsoleCondition {
  key: string;
  severity: AlertSeverity;
  title: string;
  detail: string;
}

export interface AutopilotSummary {
  /** False when the host autopilot has never written a status. */
  installed: boolean;
  checkedAt: string | null;
  /** No status for longer than {@link STALE_AFTER_MS}. */
  stale: boolean;
  growthConfigured: boolean;
  growthError: string | null;
  sizeBytes: number | null;
  usedPercent: number | null;
  growAtPercent: number | null;
  maxSizeGb: number | null;
  lastGrowAt: string | null;
}

export interface ConsoleAlertFeed {
  alerts: ConsoleAlert[];
  conditions: ConsoleCondition[];
  autopilot: AutopilotSummary;
}

/** The disk readings the console already takes; see DiskUsageService. */
export interface DiskReading {
  key: string;
  label: string;
  available: boolean;
  usedPercent: number;
  availableBytes: number;
  criticalPercent: number;
}

interface AutopilotStatus {
  checkedAt?: string;
  lastGrowAt?: string | null;
  errors?: string[];
  thresholds?: { growAtPercent?: number; maxSizeGb?: number };
  data?: {
    blockBytes?: number | null;
    usedPercent?: number;
    growth?: { configured?: boolean; tokenOk?: boolean | null; error?: string | null; atCeiling?: boolean };
  } | null;
}

/** The autopilot runs every minute; five quiet minutes means it is not running. */
const STALE_AFTER_MS = 5 * 60 * 1000;
const SEVERITIES = new Set<AlertSeverity>(['critical', 'warning']);
const GB = 1024 ** 3;

@Injectable()
export class PlatformAlertsService {
  private readonly logger = new Logger(PlatformAlertsService.name);
  /** Size and mtime of the event log at the last import; unchanged = nothing new. */
  private importedSignature: string | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {}

  private get autopilotDir(): string {
    return this.config.get<string>('disk.autopilotDir') || '/host/storage-autopilot';
  }

  async getFeed(disks: DiskReading[]): Promise<ConsoleAlertFeed> {
    await this.importHostEvents().catch((err) =>
      this.logger.warn(`Could not import storage autopilot events: ${err.message}`),
    );
    const status = await this.readStatus();
    const rows = await this.prisma.platformAlert.findMany({
      where: { acknowledgedAt: null },
      orderBy: { occurredAt: 'desc' },
      take: 50,
    });

    const autopilot = summarise(status);
    return {
      alerts: rows.map((r) => ({
        id: r.id,
        source: r.source,
        kind: r.kind,
        severity: SEVERITIES.has(r.severity as AlertSeverity) ? (r.severity as AlertSeverity) : 'warning',
        title: r.title,
        detail: r.detail,
        metadata: r.metadata,
        occurredAt: r.occurredAt.toISOString(),
      })),
      conditions: [
        ...diskConditions(disks),
        ...(this.config.get<boolean>('disk.autopilotRequired') ? autopilotConditions(status, autopilot) : []),
      ],
      autopilot,
    };
  }

  /**
   * Record an event raised by the API itself. An unacknowledged alert of the
   * same kind from the last hour absorbs repeats, so a retried operation
   * cannot bury the console in copies.
   */
  async raise(input: {
    kind: string;
    severity: AlertSeverity;
    title: string;
    detail?: string;
    metadata?: Record<string, unknown>;
  }): Promise<void> {
    try {
      const recent = await this.prisma.platformAlert.findFirst({
        where: {
          kind: input.kind,
          acknowledgedAt: null,
          occurredAt: { gte: new Date(Date.now() - 60 * 60 * 1000) },
        },
        select: { id: true },
      });
      if (recent) return;
      await this.prisma.platformAlert.create({
        data: {
          id: randomUUID(),
          source: 'platform-api',
          kind: input.kind,
          severity: input.severity,
          title: input.title.slice(0, 300),
          detail: input.detail ?? null,
          metadata: (input.metadata ?? undefined) as Prisma.InputJsonValue | undefined,
          occurredAt: new Date(),
        },
      });
    } catch (err: any) {
      // An alert that cannot be stored must never fail the operation it describes.
      this.logger.error(`Could not record platform alert ${input.kind}: ${err.message}`);
    }
  }

  async acknowledge(id: string, userId: string): Promise<{ acknowledged: number }> {
    const { count } = await this.prisma.platformAlert.updateMany({
      where: { id, acknowledgedAt: null },
      data: { acknowledgedAt: new Date(), acknowledgedBy: userId },
    });
    if (count === 0 && !(await this.prisma.platformAlert.findUnique({ where: { id }, select: { id: true } }))) {
      throw new NotFoundException('Alert not found');
    }
    return { acknowledged: count };
  }

  async acknowledgeAll(userId: string): Promise<{ acknowledged: number }> {
    const { count } = await this.prisma.platformAlert.updateMany({
      where: { acknowledgedAt: null },
      data: { acknowledgedAt: new Date(), acknowledgedBy: userId },
    });
    return { acknowledged: count };
  }

  // ── Host autopilot ─────────────────────────────────────────────────────────

  private async readStatus(): Promise<AutopilotStatus | null> {
    try {
      return JSON.parse(await fs.readFile(path.join(this.autopilotDir, 'status.json'), 'utf8'));
    } catch {
      return null;
    }
  }

  private async importHostEvents(): Promise<void> {
    const file = path.join(this.autopilotDir, 'events.jsonl');
    let signature: string;
    try {
      const st = await fs.stat(file);
      signature = `${st.size}:${st.mtimeMs}`;
    } catch {
      return;
    }
    if (signature === this.importedSignature) return;

    const data: Prisma.PlatformAlertCreateManyInput[] = [];
    for (const line of (await fs.readFile(file, 'utf8')).split('\n')) {
      if (!line.trim()) continue;
      let entry: any;
      try {
        entry = JSON.parse(line);
      } catch {
        continue;
      }
      const occurredAt = new Date(entry?.at);
      if (typeof entry?.id !== 'string' || entry.id.length > 64 || typeof entry.title !== 'string') continue;
      if (isNaN(occurredAt.getTime())) continue;
      data.push({
        id: entry.id,
        source: String(entry.source || 'storage-autopilot').slice(0, 40),
        kind: String(entry.kind || 'unknown').slice(0, 60),
        severity: SEVERITIES.has(entry.severity) ? entry.severity : 'warning',
        title: entry.title.slice(0, 300),
        detail: typeof entry.detail === 'string' ? entry.detail : null,
        metadata: entry.metadata && typeof entry.metadata === 'object' ? entry.metadata : undefined,
        occurredAt,
      });
    }
    if (data.length > 0) {
      await this.prisma.platformAlert.createMany({ data, skipDuplicates: true });
    }
    this.importedSignature = signature;
  }
}

function summarise(status: AutopilotStatus | null): AutopilotSummary {
  const checkedAt = status?.checkedAt ?? null;
  const age = checkedAt ? Date.now() - new Date(checkedAt).getTime() : Infinity;
  const growth = status?.data?.growth;
  return {
    installed: !!status,
    checkedAt,
    stale: !(age < STALE_AFTER_MS),
    growthConfigured: !!growth?.configured && growth.tokenOk !== false,
    growthError: growth?.error ?? null,
    sizeBytes: status?.data?.blockBytes ?? null,
    usedPercent: status?.data?.usedPercent ?? null,
    growAtPercent: status?.thresholds?.growAtPercent ?? null,
    maxSizeGb: status?.thresholds?.maxSizeGb ?? null,
    lastGrowAt: status?.lastGrowAt ?? null,
  };
}

function diskConditions(disks: DiskReading[]): ConsoleCondition[] {
  return disks
    .filter((d) => d.available && d.usedPercent >= d.criticalPercent)
    .map((d) => ({
      key: `disk_${d.key}`,
      severity: 'critical' as const,
      title: `${d.label} at ${d.usedPercent}%`,
      detail: `${(d.availableBytes / GB).toFixed(0)} GB free, past the ${d.criticalPercent}% critical threshold.`,
    }));
}

function autopilotConditions(status: AutopilotStatus | null, summary: AutopilotSummary): ConsoleCondition[] {
  if (!status) {
    return [
      {
        key: 'autopilot_missing',
        severity: 'critical',
        title: 'Storage autopilot is not reporting',
        detail: 'The host has never written an autopilot status, so the data volume will not grow by itself.',
      },
    ];
  }
  const out: ConsoleCondition[] = [];
  if (summary.stale) {
    const minutes = summary.checkedAt
      ? Math.round((Date.now() - new Date(summary.checkedAt).getTime()) / 60000)
      : null;
    out.push({
      key: 'autopilot_stale',
      severity: 'critical',
      title: minutes !== null ? `Storage autopilot silent for ${minutes} minutes` : 'Storage autopilot is silent',
      detail: 'It normally reports every minute. Until it runs again the data volume will not grow by itself.',
    });
  }
  const growth = status.data?.growth;
  if (growth && !growth.configured) {
    out.push({
      key: 'autopilot_no_token',
      severity: 'critical',
      title: 'Automatic volume growth is off',
      detail: 'No Hetzner Cloud API token is configured on the host, so a filling data volume can only be grown by hand.',
    });
  } else if (growth?.tokenOk === false) {
    out.push({
      key: 'autopilot_token_rejected',
      severity: 'critical',
      title: 'Automatic volume growth is failing',
      detail: `Hetzner rejected the autopilot's API token: ${growth.error ?? 'no detail'}.`,
    });
  }
  if (growth?.atCeiling) {
    out.push({
      key: 'autopilot_ceiling',
      severity: 'critical',
      title: 'Data volume is at its automatic growth ceiling',
      detail: `It will not grow past ${summary.maxSizeGb ?? '?'} GB without a higher MAX_SIZE_GB.`,
    });
  }
  if (status.errors?.length) {
    out.push({
      key: 'autopilot_errors',
      severity: 'warning',
      title: 'Storage autopilot reported a problem',
      detail: status.errors.join('; ').slice(0, 500),
    });
  }
  return out;
}
