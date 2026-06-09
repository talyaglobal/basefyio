/**
 * Infrastructure Provisioning — Drizzle schema.
 *
 * Design invariants enforced here:
 *   • Every operation requires an idempotency_key; the DB UNIQUE constraint is the
 *     last line of defence after the service-layer check.
 *   • dry_run is a first-class column on operations — the service layer MUST honour it;
 *     the schema cannot enforce "no side-effects", but it records the intent immutably.
 *   • Credential bytes NEVER enter the DB; only a Vault/OpenBao path reference is stored.
 *   • Region and datacenter are explicit, non-nullable on resources.
 *   • Operation status follows a strict state machine:
 *       PENDING → PLANNING → APPROVED → APPLYING → SUCCEEDED | FAILED | CANCELLED
 *     Additional terminal states: CANCELLED (user abort), FAILED (provider error).
 *   • audit_events is append-only; no UPDATE or DELETE should ever touch it.
 *
 * Provider enum is extensible: start with HETZNER, add AWS/GCP/AZURE later by
 * running `ALTER TYPE provisioning_provider ADD VALUE '...'` (additive, non-destructive).
 */

import {
  pgTable,
  text,
  boolean,
  varchar,
  timestamp,
  jsonb,
  pgEnum,
  uniqueIndex,
  index,
} from 'drizzle-orm/pg-core';
import { relations, sql } from 'drizzle-orm';
import { projects } from './_refs';

// ── Enums ─────────────────────────────────────────────────

export const provisioningProvider = pgEnum('provisioning_provider', [
  'hetzner',
  'aws',
  'gcp',
  'azure',
]);

export const provisioningResourceState = pgEnum('provisioning_resource_state', [
  'present', // desired: resource should exist
  'absent',  // desired: resource should be destroyed
]);

export const provisioningResourceStatus = pgEnum(
  'provisioning_resource_status',
  [
    'unknown',   // not yet queried
    'creating',  // create op in-flight
    'running',   // healthy and available
    'updating',  // update op in-flight
    'deleting',  // destroy op in-flight
    'deleted',   // provider confirmed deletion
    'error',     // provider returned an error
  ],
);

export const provisioningOperationType = pgEnum(
  'provisioning_operation_type',
  [
    'plan',      // read-only diff; always dry-run
    'create',
    'update',
    'destroy',
    'rollback',
  ],
);

export const provisioningOperationStatus = pgEnum(
  'provisioning_operation_status',
  [
    'pending',    // created, not yet dispatched
    'planning',   // computing diff / cost estimate
    'approved',   // waiting for apply (human gate or auto)
    'applying',   // provider API calls in-flight
    'succeeded',  // all changes applied successfully
    'failed',     // provider returned an error
    'cancelled',  // user aborted before applying
  ],
);

export const provisioningActorType = pgEnum('provisioning_actor_type', [
  'user',
  'system',
  'api_key',
]);

// ── provisioning_credential_refs ──────────────────────────
// Vault/OpenBao path reference. Credential bytes never enter this DB.

export const provisioningCredentialRefs = pgTable(
  'provisioning_credential_refs',
  {
    id: text('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    projectId: text('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    provider: provisioningProvider('provider').notNull(),

    // Vault/OpenBao mount + path — together they resolve the secret at runtime.
    vaultMount: varchar('vault_mount', { length: 256 }).notNull(),
    // e.g. "hetzner/project-abc" within the mount.
    vaultPath: varchar('vault_path', { length: 512 }).notNull(),

    description: text('description'),

    createdAt: timestamp('created_at', { precision: 3 }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { precision: 3 })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => ({
    projectProviderIdx: index('prov_cred_refs_project_provider_idx').on(
      t.projectId,
      t.provider,
    ),
  }),
);

// ── provisioning_projects ─────────────────────────────────
// Links a platform project to a provisioning configuration.

export const provisioningProjects = pgTable(
  'provisioning_projects',
  {
    id: text('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    // FK to the platform project.
    projectId: text('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    // Denormalized from project for cheap team-scoped queries.
    teamId: text('team_id').notNull(),

    provider: provisioningProvider('provider').notNull(),
    // Default region / datacenter for resources without explicit overrides.
    region: varchar('region', { length: 64 }).notNull(),
    datacenter: varchar('datacenter', { length: 64 }).notNull(),

    credentialRefId: text('credential_ref_id').references(
      () => provisioningCredentialRefs.id,
      { onDelete: 'set null' },
    ),

    enabled: boolean('enabled').notNull().default(true),
    // Provider-specific project-level config (e.g. Hetzner project ID).
    config: jsonb('config').$type<Record<string, unknown>>().notNull().default({}),

    createdAt: timestamp('created_at', { precision: 3 }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { precision: 3 })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => ({
    // One active provisioning config per platform project per provider.
    projectProviderUnique: uniqueIndex('prov_projects_project_provider_uq').on(
      t.projectId,
      t.provider,
    ),
    teamIdx: index('prov_projects_team_idx').on(t.teamId),
  }),
);

// ── provisioning_resources ────────────────────────────────

export const provisioningResources = pgTable(
  'provisioning_resources',
  {
    id: text('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    projectId: text('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    provisioningProjectId: text('provisioning_project_id')
      .notNull()
      .references(() => provisioningProjects.id, { onDelete: 'cascade' }),

    provider: provisioningProvider('provider').notNull(),
    // Logical resource type: 'server', 'network', 'firewall', 'load_balancer', etc.
    resourceType: varchar('resource_type', { length: 64 }).notNull(),
    // Provider-specific sub-type / SKU (e.g. Hetzner server type 'cx21').
    resourceKind: varchar('resource_kind', { length: 128 }),

    // Provider-assigned ID once the resource exists.
    externalId: varchar('external_id', { length: 256 }),

    state: provisioningResourceState('state').notNull().default('present'),
    status: provisioningResourceStatus('status').notNull().default('unknown'),

    // Explicit location — required, not inferred from provisioning_project.
    region: varchar('region', { length: 64 }).notNull(),
    datacenter: varchar('datacenter', { length: 64 }).notNull(),

    // What we declared (input).
    desiredConfig: jsonb('desired_config')
      .$type<Record<string, unknown>>()
      .notNull()
      .default({}),
    // What the provider returned (last known live state).
    actualConfig: jsonb('actual_config').$type<Record<string, unknown>>(),

    tags: jsonb('tags').$type<Record<string, string>>(),

    // Stable caller-supplied key; prevents duplicate resource creation on retries.
    idempotencyKey: varchar('idempotency_key', { length: 256 }).notNull(),

    createdAt: timestamp('created_at', { precision: 3 }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { precision: 3 })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => ({
    // Idempotency key is scoped to the provisioning project.
    idempotencyUnique: uniqueIndex('prov_resources_idempotency_uq').on(
      t.provisioningProjectId,
      t.idempotencyKey,
    ),
    projectTypeIdx: index('prov_resources_project_type_idx').on(
      t.projectId,
      t.resourceType,
    ),
    externalIdIdx: index('prov_resources_external_id_idx').on(
      t.provider,
      t.externalId,
    ),
    statusIdx: index('prov_resources_status_idx').on(
      t.provisioningProjectId,
      t.status,
    ),
  }),
);

// ── provisioning_operations ───────────────────────────────
// State machine for every infra change. One row per operation attempt.

export interface CostEstimate {
  hourlyUsd: number;
  monthlyUsd: number;
  currency: string;
  breakdown?: Array<{ label: string; hourlyUsd: number }>;
}

export const provisioningOperations = pgTable(
  'provisioning_operations',
  {
    id: text('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    projectId: text('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    provisioningProjectId: text('provisioning_project_id')
      .notNull()
      .references(() => provisioningProjects.id, { onDelete: 'cascade' }),
    // Null for project-level operations (e.g. plan all resources).
    resourceId: text('resource_id').references(() => provisioningResources.id, {
      onDelete: 'set null',
    }),

    operationType: provisioningOperationType('operation_type').notNull(),
    status: provisioningOperationStatus('status')
      .notNull()
      .default('pending'),

    // First-class dry-run flag — plan ops are always dry-run.
    dryRun: boolean('dry_run').notNull().default(false),

    // Stable caller-supplied key; prevents duplicate operations on retries.
    idempotencyKey: varchar('idempotency_key', { length: 256 }).notNull(),

    // Planning output (diff, resource graph, warnings).
    planOutput: jsonb('plan_output').$type<Record<string, unknown>>(),
    // Structured cost estimate — separated from plan_output for easy querying.
    costEstimate: jsonb('cost_estimate').$type<CostEstimate>(),
    // Provider API response after apply.
    applyOutput: jsonb('apply_output').$type<Record<string, unknown>>(),

    error: text('error'),
    errorCode: varchar('error_code', { length: 64 }),

    // Human or automated approval gate.
    approvedBy: text('approved_by'),
    approvedAt: timestamp('approved_at', { precision: 3 }),

    createdBy: text('created_by'),
    createdAt: timestamp('created_at', { precision: 3 }).notNull().defaultNow(),
    startedAt: timestamp('started_at', { precision: 3 }),
    completedAt: timestamp('completed_at', { precision: 3 }),
  },
  (t) => ({
    // Idempotency key scoped to provisioning project.
    idempotencyUnique: uniqueIndex('prov_operations_idempotency_uq').on(
      t.provisioningProjectId,
      t.idempotencyKey,
    ),
    projectStatusIdx: index('prov_operations_project_status_idx').on(
      t.projectId,
      t.status,
    ),
    resourceIdx: index('prov_operations_resource_idx').on(t.resourceId),
    // Partial index for in-flight operations — used by the poller.
    inFlightIdx: index('prov_operations_in_flight_idx')
      .on(t.provisioningProjectId, t.status)
      .where(sql`${t.status} IN ('pending','planning','approved','applying')`),
  }),
);

// ── provisioning_audit_events ─────────────────────────────
// Append-only. No UPDATE or DELETE ever touches this table.

export const provisioningAuditEvents = pgTable(
  'provisioning_audit_events',
  {
    id: text('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    projectId: text('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    // Nullable refs — an event may outlive its operation/resource.
    operationId: text('operation_id').references(
      () => provisioningOperations.id,
      { onDelete: 'set null' },
    ),
    resourceId: text('resource_id').references(() => provisioningResources.id, {
      onDelete: 'set null',
    }),

    actorId: text('actor_id'),
    actorType: provisioningActorType('actor_type').notNull().default('system'),

    // Dot-namespaced event type: 'operation.created', 'operation.approved', etc.
    eventType: varchar('event_type', { length: 128 }).notNull(),

    // Immutable before/after snapshots for rollback analysis.
    beforeState: jsonb('before_state').$type<Record<string, unknown>>(),
    afterState: jsonb('after_state').$type<Record<string, unknown>>(),

    metadata: jsonb('metadata').$type<Record<string, unknown>>(),
    ipAddress: varchar('ip_address', { length: 45 }),

    // No updatedAt — this table is strictly append-only.
    createdAt: timestamp('created_at', { precision: 3 }).notNull().defaultNow(),
  },
  (t) => ({
    projectCreatedIdx: index('prov_audit_project_created_idx').on(
      t.projectId,
      t.createdAt,
    ),
    operationIdx: index('prov_audit_operation_idx').on(t.operationId),
    resourceIdx: index('prov_audit_resource_idx').on(t.resourceId),
    eventTypeIdx: index('prov_audit_event_type_idx').on(
      t.projectId,
      t.eventType,
    ),
  }),
);

// ── Relations ──────────────────────────────────────────────

export const provisioningProjectsRelations = relations(
  provisioningProjects,
  ({ one, many }) => ({
    credentialRef: one(provisioningCredentialRefs, {
      fields: [provisioningProjects.credentialRefId],
      references: [provisioningCredentialRefs.id],
    }),
    resources: many(provisioningResources),
    operations: many(provisioningOperations),
  }),
);

export const provisioningResourcesRelations = relations(
  provisioningResources,
  ({ one, many }) => ({
    provisioningProject: one(provisioningProjects, {
      fields: [provisioningResources.provisioningProjectId],
      references: [provisioningProjects.id],
    }),
    operations: many(provisioningOperations),
    auditEvents: many(provisioningAuditEvents),
  }),
);

export const provisioningOperationsRelations = relations(
  provisioningOperations,
  ({ one, many }) => ({
    provisioningProject: one(provisioningProjects, {
      fields: [provisioningOperations.provisioningProjectId],
      references: [provisioningProjects.id],
    }),
    resource: one(provisioningResources, {
      fields: [provisioningOperations.resourceId],
      references: [provisioningResources.id],
    }),
    auditEvents: many(provisioningAuditEvents),
  }),
);

export const provisioningAuditEventsRelations = relations(
  provisioningAuditEvents,
  ({ one }) => ({
    operation: one(provisioningOperations, {
      fields: [provisioningAuditEvents.operationId],
      references: [provisioningOperations.id],
    }),
    resource: one(provisioningResources, {
      fields: [provisioningAuditEvents.resourceId],
      references: [provisioningResources.id],
    }),
  }),
);

// ── Inferred types ─────────────────────────────────────────

export type ProvisioningCredentialRef =
  typeof provisioningCredentialRefs.$inferSelect;
export type NewProvisioningCredentialRef =
  typeof provisioningCredentialRefs.$inferInsert;

export type ProvisioningProject = typeof provisioningProjects.$inferSelect;
export type NewProvisioningProject = typeof provisioningProjects.$inferInsert;

export type ProvisioningResource = typeof provisioningResources.$inferSelect;
export type NewProvisioningResource = typeof provisioningResources.$inferInsert;

export type ProvisioningOperation = typeof provisioningOperations.$inferSelect;
export type NewProvisioningOperation =
  typeof provisioningOperations.$inferInsert;

export type ProvisioningAuditEvent =
  typeof provisioningAuditEvents.$inferSelect;
export type NewProvisioningAuditEvent =
  typeof provisioningAuditEvents.$inferInsert;
