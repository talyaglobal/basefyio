import { SetMetadata } from '@nestjs/common';

export const PLAN_GATE_KEY = 'plan_gate';

/**
 * What a route does that a plan limit can refuse (PlanGateInterceptor):
 *
 *  - `db_write`  adds data or schema (insert, update, create): refused while
 *                the organization's databases are past the size limit
 *  - `sql`       a SQL script: refused only when it adds data or schema
 *                (sqlGrowsDatabase); reads, DELETE and TRUNCATE always run
 *  - `signup`    creates a new end user of a project: refused while the
 *                organization is past its monthly active users limit
 *
 * Only takes effect in `enforce` mode for the metric; see plan-enforcement.rules.ts.
 */
export type PlanGateKind = 'db_write' | 'sql' | 'signup';

export const PlanGate = (kind: PlanGateKind) => SetMetadata(PLAN_GATE_KEY, kind);
