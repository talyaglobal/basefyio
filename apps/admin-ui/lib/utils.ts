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
