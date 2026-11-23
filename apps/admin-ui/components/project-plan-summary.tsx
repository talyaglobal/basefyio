'use client';

import { Info } from 'lucide-react';
import type { ComputeOptions } from '@/lib/types';
import {
  DB_LIMIT_SENTENCE,
  FILE_LIMIT_SENTENCE,
  PRICING_DOCS_URL,
  REGION_SUMMARY,
  SHARED_COMPUTE_SENTENCE,
  STORAGE_BILLING_SENTENCE,
  limitLabel,
  type PlanLimits,
} from '@/lib/plan-resources';

interface ProjectPlanSummaryProps {
  planDisplayName: string | null;
  limits: PlanLimits | null;
  compute: ComputeOptions['tiers'][number] | null;
}

/** "What you get": what a new project on the selected organization's plan gets and costs. */
export function ProjectPlanSummary({ planDisplayName, limits, compute }: ProjectPlanSummaryProps) {
  const dedicated = compute !== null && compute.vcpu !== null;
  return (
    <div className="rounded-md border bg-muted/40 p-3 text-xs text-muted-foreground" data-testid="plan-summary">
      <p className="mb-1.5 flex items-center gap-1.5 font-medium text-foreground">
        <Info className="h-3.5 w-3.5" />
        What you get{planDisplayName ? ` on the ${planDisplayName} plan` : ''}
      </p>
      <dl className="grid grid-cols-[7rem_1fr] gap-x-3 gap-y-1">
        <dt>Region</dt>
        <dd className="text-foreground">{REGION_SUMMARY}</dd>
        <dt>Compute</dt>
        <dd>
          {dedicated ? (
            <span className="text-foreground">
              {compute.label} · {compute.vcpu} vCPU · {compute.memoryGb} GB RAM, reserved for this project
            </span>
          ) : (
            <span>{SHARED_COMPUTE_SENTENCE}</span>
          )}
        </dd>
        <dt>Database size</dt>
        <dd className="text-foreground">
          {limits ? `${limitLabel(limits.maxDbSizeBytes)} across the organization` : 'See Billing for your plan’s limit'}
        </dd>
        <dt>File storage</dt>
        <dd className="text-foreground">
          {limits ? `${limitLabel(limits.maxStorageBytes)} across the organization` : 'See Billing for your plan’s limit'}
        </dd>
        <dt>Billing</dt>
        <dd>{STORAGE_BILLING_SENTENCE}</dd>
        <dt>At the limit</dt>
        <dd>
          {FILE_LIMIT_SENTENCE} {DB_LIMIT_SENTENCE}
        </dd>
      </dl>
      <p className="mt-2">
        <a
          href={PRICING_DOCS_URL}
          target="_blank"
          rel="noopener noreferrer"
          className="font-medium text-primary underline-offset-2 hover:underline"
        >
          Pricing and limits
        </a>
      </p>
    </div>
  );
}
