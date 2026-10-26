import { type ClassValue, clsx } from 'clsx';
import { twMerge } from 'tailwind-merge';

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

/**
 * Format an integer with Turkish-locale thousand separators ("1.163.872").
 * Used everywhere row counts are surfaced so a long sidebar of tables is
 * readable at a glance instead of "1163872". Returns "0" for null/undefined.
 */
export function formatCount(n: number | null | undefined): string {
  if (n === null || n === undefined || Number.isNaN(n)) return '0';
  return Number(n).toLocaleString('tr-TR');
}

/**
 * Solid-pill colour classes for a project status <Badge>. Active is our teal
 * (green/turquoise) accent; deactivated is neutral gray. Pass to Badge's
 * className — twMerge lets it override the variant's default background.
 */
export function projectStatusBadgeClass(status: string | null | undefined): string {
  switch (status) {
    case 'ACTIVE':
      return 'bg-teal-500 text-white border-transparent hover:bg-teal-500';
    case 'PAUSED':
      return 'bg-amber-500 text-white border-transparent hover:bg-amber-500';
    case 'DEACTIVATED':
      return 'bg-slate-400 text-white border-transparent hover:bg-slate-400';
    case 'DELETED':
      return 'bg-red-500 text-white border-transparent hover:bg-red-500';
    default:
      return '';
  }
}

/**
 * The one word the product uses for each project status, everywhere a status
 * is shown: Active, Deactivated, Deleted. The enum value `PAUSED` is an
 * internal identifier for the deactivated state; customers never read it.
 * Legacy `DEACTIVATED` rows read the same word — they are the same thing.
 */
export function projectStatusLabel(status: string | null | undefined): string {
  switch (status) {
    case 'ACTIVE':
      return 'Active';
    case 'PAUSED':
      return 'Deactivated';
    case 'DEACTIVATED':
      return 'Deactivated';
    case 'DELETED':
      return 'Deleted';
    default:
      return status ? status.charAt(0) + status.slice(1).toLowerCase() : '';
  }
}
