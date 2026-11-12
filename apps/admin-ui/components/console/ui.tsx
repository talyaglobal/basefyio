'use client';

import type { ElementType, ReactNode } from 'react';
import { cn } from '@/lib/utils';

export function PageHeader({
  title,
  description,
  actions,
}: {
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <div className="mb-6 flex flex-wrap items-end justify-between gap-3">
      <div className="min-w-0">
        <h1 className="text-xl font-semibold tracking-tight">{title}</h1>
        {description && <p className="mt-1 text-sm text-muted-foreground">{description}</p>}
      </div>
      {actions && <div className="flex items-center gap-2">{actions}</div>}
    </div>
  );
}

export function StatCard({
  label,
  value,
  hint,
  icon: Icon,
  tone = 'default',
}: {
  label: string;
  value: ReactNode;
  hint?: ReactNode;
  icon?: ElementType;
  tone?: 'default' | 'good' | 'bad';
}) {
  return (
    <div className="h-full rounded-lg border bg-card p-4">
      <div className="flex items-center justify-between text-xs font-medium uppercase tracking-wide text-muted-foreground">
        <span>{label}</span>
        {Icon && <Icon className="h-3.5 w-3.5" />}
      </div>
      <div
        className={cn(
          'mt-2 text-2xl font-semibold tabular-nums',
          tone === 'good' && 'text-emerald-600 dark:text-emerald-400',
          tone === 'bad' && 'text-red-600 dark:text-red-400',
        )}
      >
        {value}
      </div>
      {hint && <div className="mt-1 text-xs text-muted-foreground">{hint}</div>}
    </div>
  );
}

export function Panel({
  title,
  description,
  actions,
  children,
  className,
  flush,
}: {
  title?: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
  /** Let a table run to the panel's edges. */
  flush?: boolean;
}) {
  return (
    <section className={cn('rounded-lg border bg-card', className)}>
      {(title || actions) && (
        <div className="flex flex-wrap items-start justify-between gap-2 border-b px-4 py-3">
          <div>
            {title && <h2 className="text-sm font-semibold">{title}</h2>}
            {description && <p className="mt-0.5 text-xs text-muted-foreground">{description}</p>}
          </div>
          {actions}
        </div>
      )}
      <div className={flush ? '' : 'p-4'}>{children}</div>
    </section>
  );
}

const STATUS_STYLES: Record<string, string> = {
  ACTIVE: 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-400',
  PAUSED: 'bg-amber-500/10 text-amber-700 dark:text-amber-400',
  DEACTIVATED: 'bg-zinc-500/15 text-zinc-600 dark:text-zinc-400',
  DELETED: 'bg-red-500/10 text-red-700 dark:text-red-400',
  PAST_DUE: 'bg-red-500/10 text-red-700 dark:text-red-400',
  CANCELED: 'bg-zinc-500/15 text-zinc-600 dark:text-zinc-400',
  TRIALING: 'bg-sky-500/10 text-sky-700 dark:text-sky-400',
};

export function StatusBadge({ status }: { status: string }) {
  return (
    <span
      className={cn(
        'inline-flex items-center rounded px-1.5 py-0.5 text-[11px] font-medium',
        STATUS_STYLES[status] ?? 'bg-muted text-muted-foreground',
      )}
    >
      {status.charAt(0) + status.slice(1).toLowerCase().replace(/_/g, ' ')}
    </span>
  );
}

export const REVENUE_STATE_LABELS: Record<string, string> = {
  paying: 'Paying',
  free: 'Free plan',
  trialing: 'Trial',
  past_due: 'Past due',
  canceled: 'Canceled',
  incomplete: 'Payment incomplete',
  frozen: 'Account frozen',
  unbilled: 'Not billed',
  lapsed: 'Renewal overdue',
};

export const REVENUE_STATE_HINTS: Record<string, string> = {
  paying: 'Counted in recurring revenue',
  free: 'No price, or a 100% discount',
  trialing: 'Not charged yet',
  past_due: 'The last charge failed; not counted until it is paid',
  canceled: 'Subscription canceled',
  incomplete: 'The first payment never completed',
  frozen: 'Account frozen after unpaid charges',
  unbilled: 'Paid plan without a payment method or charge schedule — nothing charges it',
  lapsed: 'The renewal date passed more than 3 days ago without a successful charge',
};

const REVENUE_STATE_STYLES: Record<string, string> = {
  paying: 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-400',
  past_due: 'bg-red-500/10 text-red-700 dark:text-red-400',
  lapsed: 'bg-amber-500/10 text-amber-700 dark:text-amber-400',
  unbilled: 'bg-amber-500/10 text-amber-700 dark:text-amber-400',
  frozen: 'bg-red-500/10 text-red-700 dark:text-red-400',
  trialing: 'bg-sky-500/10 text-sky-700 dark:text-sky-400',
};

export function RevenueStateBadge({ state }: { state: string | null | undefined }) {
  if (!state) return null;
  return (
    <span
      title={REVENUE_STATE_HINTS[state]}
      className={cn(
        'inline-flex items-center whitespace-nowrap rounded px-1.5 py-0.5 text-[11px] font-medium',
        REVENUE_STATE_STYLES[state] ?? 'bg-muted text-muted-foreground',
      )}
    >
      {REVENUE_STATE_LABELS[state] ?? state}
    </span>
  );
}

export function Spinner() {
  return (
    <div className="flex justify-center py-20">
      <div className="h-6 w-6 animate-spin rounded-full border-2 border-muted border-t-foreground" />
    </div>
  );
}

export function ErrorState({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div className="rounded-lg border border-dashed px-6 py-12 text-center">
      <p className="text-sm text-muted-foreground">{message}</p>
      {onRetry && (
        <button onClick={onRetry} className="mt-3 text-sm font-medium text-primary hover:underline">
          Try again
        </button>
      )}
    </div>
  );
}

/** A thin horizontal meter; `value` is 0..1. */
export function Meter({ value, className }: { value: number; className?: string }) {
  return (
    <div className={cn('h-1.5 w-full overflow-hidden rounded-full bg-muted', className)}>
      <div className="h-full rounded-full bg-primary" style={{ width: `${Math.min(100, Math.max(0, value * 100))}%` }} />
    </div>
  );
}

export const th = 'px-3 py-2 text-left text-[11px] font-medium uppercase tracking-wide text-muted-foreground';
export const thRight = `${th} text-right`;
export const td = 'px-3 py-2 align-middle';
export const tdRight = `${td} text-right tabular-nums`;

/** A column header that sorts the table; announces its state through aria-sort. */
export function SortHeader<K extends string>({
  label,
  sortKey,
  sort,
  onSort,
  align = 'right',
  defaultDesc = true,
  className,
}: {
  label: string;
  sortKey: K;
  sort: { key: K; desc: boolean };
  onSort: (next: { key: K; desc: boolean }) => void;
  align?: 'left' | 'right';
  /** Direction on the first click: numbers start largest-first, names A–Z. */
  defaultDesc?: boolean;
  className?: string;
}) {
  const active = sort.key === sortKey;
  return (
    <th
      className={cn(align === 'right' ? thRight : th, className)}
      aria-sort={active ? (sort.desc ? 'descending' : 'ascending') : 'none'}
      scope="col"
    >
      <button
        type="button"
        onClick={() => onSort({ key: sortKey, desc: active ? !sort.desc : defaultDesc })}
        className={cn('inline-flex items-center gap-1 uppercase hover:text-foreground', active && 'text-foreground')}
      >
        {label}
        {active && <span aria-hidden>{sort.desc ? '↓' : '↑'}</span>}
      </button>
    </th>
  );
}

/** Segmented filter buttons; the pressed one is announced with aria-pressed. */
export function FilterChips<V extends string>({
  options,
  value,
  onChange,
  label,
}: {
  options: Array<{ value: V; label: string }>;
  value: V;
  onChange: (value: V) => void;
  /** What the group filters, for screen readers. */
  label: string;
}) {
  return (
    <div role="group" aria-label={label} className="flex flex-wrap rounded-md border bg-card p-0.5">
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          aria-pressed={value === o.value}
          onClick={() => onChange(o.value)}
          className={cn(
            'rounded px-2.5 py-1 text-xs font-medium',
            value === o.value ? 'bg-muted text-foreground' : 'text-muted-foreground hover:text-foreground',
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

/** A full-width table row saying why the table is empty. */
export function EmptyRow({ colSpan, children }: { colSpan: number; children: ReactNode }) {
  return (
    <tr>
      <td colSpan={colSpan} className="px-3 py-10 text-center text-sm text-muted-foreground">
        {children}
      </td>
    </tr>
  );
}

/** Previous / next paging for a client-side list. */
export function Pager({
  page,
  pageCount,
  onPage,
  total,
  pageSize,
}: {
  page: number;
  pageCount: number;
  onPage: (page: number) => void;
  total: number;
  pageSize: number;
}) {
  if (pageCount <= 1) return null;
  const from = (page - 1) * pageSize + 1;
  const to = Math.min(page * pageSize, total);
  return (
    <div className="flex items-center justify-between gap-2 border-t px-3 py-2 text-xs text-muted-foreground">
      <span>
        {from.toLocaleString('en-US')}–{to.toLocaleString('en-US')} of {total.toLocaleString('en-US')}
      </span>
      <div className="flex items-center gap-1">
        <button
          type="button"
          className="rounded border px-2 py-1 hover:bg-muted disabled:opacity-40"
          disabled={page <= 1}
          onClick={() => onPage(page - 1)}
        >
          Previous
        </button>
        <span className="px-1">
          Page {page} of {pageCount}
        </span>
        <button
          type="button"
          className="rounded border px-2 py-1 hover:bg-muted disabled:opacity-40"
          disabled={page >= pageCount}
          onClick={() => onPage(page + 1)}
        >
          Next
        </button>
      </div>
    </div>
  );
}
