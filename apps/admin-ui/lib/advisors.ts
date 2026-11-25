/** Response of GET /projects/:id/advisors (#218). */
export type AdvisorSeverity = 'error' | 'warn' | 'info';
export type AdvisorCategory = 'security' | 'performance';

export interface AdvisorFinding {
  id: string;
  ruleId: string;
  severity: AdvisorSeverity;
  category: AdvisorCategory;
  title: string;
  detail: string;
  entity: string;
  fixSql: string;
  docsHint: string;
}

export interface AdvisorReport {
  generatedAt: string;
  counts: {
    total: number;
    error: number;
    warn: number;
    info: number;
    security: number;
    performance: number;
  };
  findings: AdvisorFinding[];
  skippedRules: { ruleId: string; reason: string }[];
}
