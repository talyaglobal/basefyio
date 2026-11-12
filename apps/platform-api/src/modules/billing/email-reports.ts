/**
 * Settings and calendar rules for the root email reports (Admin › Email Reports).
 *
 * Monthly reports used to run on the 30th, which February never has, and the
 * yearly one on December 30th, a day before the year ends. They now run on
 * the last day of the month and on December 31st, covering the whole month
 * and the whole year.
 */

export const EMAIL_REPORTS_KEY = 'email_reports_config';

/** Where reports go when nobody has been configured. */
export const DEFAULT_REPORT_RECIPIENT =
  process.env.BILLING_SUMMARY_RECIPIENT || 'support@talyasmart.com';

export const MAX_REPORT_RECIPIENTS = 10;

export type ReportPeriod = 'Daily' | 'Weekly' | 'Monthly' | 'Yearly';

export interface EmailReportsConfig {
  schedule: { daily: boolean; weekly: boolean; monthly: boolean; yearly: boolean };
  content: Record<string, boolean>;
  /** Who receives the reports; empty or missing means the default address. */
  recipients?: string[];
}

export const DEFAULT_EMAIL_REPORTS_CONFIG: EmailReportsConfig = {
  schedule: { daily: false, weekly: false, monthly: false, yearly: false },
  content: {
    newUsers: true,
    newProjects: true,
    deletedProjects: true,
    newTeams: true,
    deletedTeams: true,
    searchConsole: true,
    analytics: true,
    stripe: true,
  },
  recipients: [],
};

const EMAIL_RE = /^[^\s@<>()[\],;:"]+@[^\s@<>()[\],;:"]+\.[^\s@<>()[\],;:"]+$/;

/**
 * Clean a recipient list from the dashboard: trimmed, lower-cased, unique,
 * valid addresses only. Throws with a readable message on a bad entry so the
 * admin sees which one to fix instead of reports silently going nowhere.
 */
export function normalizeRecipients(input: unknown): string[] {
  if (input == null) return [];
  if (!Array.isArray(input)) throw new Error('Recipients must be a list of email addresses.');
  const out: string[] = [];
  for (const raw of input) {
    const email = String(raw ?? '').trim().toLowerCase();
    if (!email) continue;
    if (email.length > 254 || !EMAIL_RE.test(email)) {
      throw new Error(`"${String(raw).slice(0, 80)}" is not a valid email address.`);
    }
    if (!out.includes(email)) out.push(email);
  }
  if (out.length > MAX_REPORT_RECIPIENTS) {
    throw new Error(`At most ${MAX_REPORT_RECIPIENTS} recipients are allowed.`);
  }
  return out;
}

/** The addresses a report is actually sent to. */
export function reportRecipients(config: Pick<EmailReportsConfig, 'recipients'> | null | undefined): string[] {
  const list = Array.isArray(config?.recipients) ? config!.recipients.filter(Boolean) : [];
  return list.length ? list : [DEFAULT_REPORT_RECIPIENT];
}

/** True on the last calendar day of the month, in UTC. */
export function isLastDayOfMonthUtc(now: Date): boolean {
  const tomorrow = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1));
  return tomorrow.getUTCMonth() !== now.getUTCMonth();
}

/** Start of the window a report covers. */
export function reportPeriodStart(period: ReportPeriod, now: Date): Date {
  switch (period) {
    case 'Daily':
      return new Date(now.getTime() - 24 * 60 * 60 * 1000);
    case 'Weekly':
      return new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
    case 'Monthly':
      return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
    case 'Yearly':
      return new Date(Date.UTC(now.getUTCFullYear(), 0, 1));
  }
}
