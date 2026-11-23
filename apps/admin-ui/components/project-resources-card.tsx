'use client';

import { useEffect, useState } from 'react';
import { Server } from 'lucide-react';
import { api } from '@/lib/api';
import { formatBytes, formatDateTime } from '@/lib/format';
import type { MeteredResource, ProjectResources } from '@/lib/types';
import {
  DB_LIMIT_SENTENCE,
  FILE_LIMIT_SENTENCE,
  PRICING_DOCS_URL,
  SHARED_COMPUTE_SENTENCE,
  STORAGE_BILLING_SENTENCE,
} from '@/lib/plan-resources';

interface ProjectResourcesCardProps {
  projectId: string;
  /** The connection endpoint the project already shows (the pooler's public host). */
  host: string;
  port: number;
}

function Meter({ label, m, note }: { label: string; m: MeteredResource; note: string }) {
  const unlimited = m.limitBytes === null;
  const pct = unlimited || !m.limitBytes ? 0 : Math.min(100, (m.organizationBytes / m.limitBytes) * 100);
  return (
    <div>
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="mt-0.5">
        <span className="text-foreground">
          {formatBytes(m.projectBytes)} in this project
        </span>
        <span className="text-muted-foreground">
          {' · '}
          {formatBytes(m.organizationBytes)} of {unlimited ? 'Unlimited' : formatBytes(m.limitBytes)} across the organization
        </span>
        {!unlimited && (
          <div className="mt-1 h-1.5 w-full overflow-hidden rounded-full bg-muted" aria-hidden="true">
            <div
              className={`h-full rounded-full ${pct >= 90 ? 'bg-destructive' : 'bg-primary'}`}
              style={{ width: `${pct}%` }}
            />
          </div>
        )}
        <p className="mt-1 text-xs text-muted-foreground">
          {note}
          {m.measuredAt ? ` Measured ${formatDateTime(m.measuredAt)}.` : ''}
        </p>
      </dd>
    </div>
  );
}

/** Overview card: where the project runs, what compute it has, and its size against the plan's limits. */
export function ProjectResourcesCard({ projectId, host, port }: ProjectResourcesCardProps) {
  const [res, setRes] = useState<ProjectResources | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setFailed(false);
    api.projects
      .resources(projectId)
      .then((r) => { if (!cancelled) setRes(r); })
      .catch(() => { if (!cancelled) setFailed(true); });
    return () => { cancelled = true; };
  }, [projectId]);

  return (
    <div className="rounded-lg border bg-card p-5" data-testid="project-resources">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2 text-sm font-medium text-muted-foreground">
          <Server className="h-4 w-4" />
          Resources{res?.plan ? ` · ${res.plan.displayName} plan` : ''}
        </div>
        <a
          href={PRICING_DOCS_URL}
          target="_blank"
          rel="noopener noreferrer"
          className="text-xs font-medium text-primary underline-offset-2 hover:underline"
        >
          Pricing and limits
        </a>
      </div>

      {failed && <p className="mt-3 text-sm text-muted-foreground">Resource details are not available right now.</p>}
      {!res && !failed && <p className="mt-3 text-sm text-muted-foreground">Loading...</p>}

      {res && (
        <dl className="mt-3 grid gap-x-8 gap-y-3 text-sm md:grid-cols-2">
          <div>
            <dt className="text-muted-foreground">Connection</dt>
            <dd className="mt-0.5 font-mono text-foreground break-all">
              {host}:{port}
            </dd>
          </div>
          <div>
            <dt className="text-muted-foreground">Region</dt>
            <dd className="mt-0.5 text-foreground">
              {res.region.label} · {res.region.location}
            </dd>
          </div>
          <div className="md:col-span-2">
            <dt className="text-muted-foreground">Compute</dt>
            <dd className="mt-0.5">
              {res.compute.reserved ? (
                <span className="text-foreground">
                  {res.compute.label} · {res.compute.vcpu} vCPU · {res.compute.memoryGb} GB RAM, reserved for this project
                </span>
              ) : (
                <span className="text-muted-foreground">
                  <span className="text-foreground">Shared.</span> {SHARED_COMPUTE_SENTENCE}
                </span>
              )}
            </dd>
          </div>
          <Meter label="Database size" m={res.database} note={DB_LIMIT_SENTENCE} />
          <Meter label="File storage" m={res.storage} note={FILE_LIMIT_SENTENCE} />
          <div className="md:col-span-2 text-xs text-muted-foreground">
            {STORAGE_BILLING_SENTENCE}
            {res.uncapped ? ' Your plan has no database or file storage cap.' : ''}
          </div>
        </dl>
      )}
    </div>
  );
}
