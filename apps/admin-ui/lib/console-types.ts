/** Shapes returned by the root console API (`/admin/console/*`). */

export interface ConsolePlanRef {
  name: string;
  displayName: string;
  priceMonthlyUsd: number;
  status: string;
}

export interface ConsoleTopProject {
  id: string;
  name: string;
  teamName: string;
  projectedRawUsd: number;
  projectedPricedUsd: number;
  dbSizeBytes: number;
  storageBytes: number;
}

export type StorageCategory = 'project' | 'deleted_project' | 'platform' | 'orphan';

export interface ConsoleStorageSummary {
  measuredAt: string | null;
  bucketCount: number;
  objectCount: number;
  totalBytes: number;
  byCategory: Record<StorageCategory, number>;
}

/**
 * Where a team stands for recurring revenue. One definition is shared by the
 * Overview, Infrastructure costs and Stripe screens (billing/recurring-revenue.ts).
 */
export type RevenueState =
  | 'paying'
  | 'free'
  | 'trialing'
  | 'past_due'
  | 'canceled'
  | 'incomplete'
  | 'frozen'
  | 'unbilled'
  | 'lapsed';

export type RevenueByState = Record<RevenueState, { teams: number; listPriceUsd: number }>;

export interface ConsolePlanTeam {
  id: string;
  name: string;
  slug: string;
  ownerEmail: string | null;
  status: string;
  revenueState?: RevenueState;
  /** What the team adds to recurring revenue: 0 unless it is paying. */
  monthlyRevenueUsd?: number;
  projects: number;
  members: number;
  createdAt: string;
  subscribedAt: string;
  currentPeriodEnd: string | null;
  /** Our raw cost for the team's projects, projected to month end. */
  projectedRawUsd: number;
  footprintBytes: number;
}

export interface ConsolePlanMix {
  name: string;
  displayName: string;
  priceMonthlyUsd: number;
  teams: number;
  /** Teams counted in recurring revenue. */
  paying: number;
  /** Their recurring revenue, after student discounts. */
  revenueUsd?: number;
  teamList: ConsolePlanTeam[];
}

export interface ConsoleOverview {
  generatedAt: string;
  period: { start: string; end: string; elapsedFraction: number; daysLeft: number };
  counts: {
    users: number;
    usersLast30d: number;
    activeUsersLast30d: number;
    teams: number;
    payingTeams: number;
    projects: {
      active: number;
      paused: number;
      deactivated: number;
      /** Projects in the trash (preview branches excluded). */
      deleted: number;
      previewBranches?: number;
      permanentlyDeletedLast30d?: number;
    };
  };
  money: {
    mrrUsd: number;
    actualMonthlyBillUsd: number;
    allocatedRawUsd: number;
    allocatedPricedUsd: number;
    marginVsBillUsd: number;
    recoveryRatio: number;
    markup: number;
    paidPlanTeams?: number;
    revenueByState?: RevenueByState;
    revenueDefinition?: string;
  };
  footprint: {
    dbBytes: number;
    projectStorageBytes: number;
    apiRequestsMonth: number;
    bandwidthMonthBytes: number;
    storage: ConsoleStorageSummary;
  };
  plans: ConsolePlanMix[];
  months: Array<{ month: string; signups: number; projects: number }>;
  topByCost: ConsoleTopProject[];
  topByFootprint: ConsoleTopProject[];
  storagePending: boolean;
  disk: { filesystems: ConsoleFilesystem[] };
}

// ── Server disk ──────────────────────────────────────────

export interface ConsoleFilesystem {
  key: 'data' | 'system';
  label: string;
  mount: string | null;
  available: boolean;
  totalBytes: number;
  usedBytes: number;
  availableBytes: number;
  usedPercent: number;
  warnPercent: number;
  criticalPercent: number;
  note: string;
}

export interface ConsoleDiskItem {
  key: string;
  label: string;
  bytes: number | null;
  hint: string;
  measuredAt: string | null;
}

export interface ConsoleDisk {
  generatedAt: string;
  filesystems: ConsoleFilesystem[];
  breakdown: {
    items: ConsoleDiskItem[];
    accountedBytes: number;
    unaccountedBytes: number | null;
    measuredAt: string | null;
    pending: boolean;
  };
  docker: { rootDir: string | null; volumes: number; dedicatedDbVolumes: number } | null;
  guard: { warnPercent: number; criticalPercent: number; schedule: string };
}

export interface ConsoleProjectRow {
  id: string;
  name: string;
  slug: string;
  status: string;
  databaseType: string;
  importSource: string;
  createdAt: string;
  team: { id: string; name: string; slug: string };
  owner: { id: string; email: string; name: string | null } | null;
  plan: ConsolePlanRef | null;
  dbSizeBytes: number;
  storageBytes: number;
  storageMeasuredAt: string | null;
  bucketCount: number | null;
  apiRequests: number;
  bandwidthBytes: number;
  cost: {
    computeTier: string;
    rawUsd: number;
    pricedUsd: number;
    projectedRawUsd: number;
    projectedPricedUsd: number;
  } | null;
}

export interface ConsoleProjectList {
  generatedAt: string;
  storageMeasuredAt: string | null;
  projects: ConsoleProjectRow[];
}

export interface ConsoleCostLine {
  key: string;
  label: string;
  detail: string;
  rawUsd: number;
  pricedUsd: number;
  projectedRawUsd: number;
  projectedPricedUsd: number;
}

export interface ConsoleProjectDetail {
  generatedAt: string;
  project: {
    id: string;
    name: string;
    /** The owner-given name (without the internal suffix a trashed project carries). */
    displayName?: string;
    slug: string;
    description: string | null;
    status: string;
    databaseType: string;
    importSource: string;
    dbName: string;
    createdAt: string;
    deletedAt: string | null;
    deactivatedAt: string | null;
  };
  team: {
    id: string;
    name: string;
    slug: string;
    createdAt: string;
    projectCount: number;
    plan: (ConsolePlanRef & { currentPeriodEnd: string | null }) | null;
    members: Array<{ role: string; id: string; email: string; name: string | null }>;
  };
  infrastructure: {
    pgContainerName: string | null;
    pgMemoryMb: number;
    pgCpuMillis: number;
    status: string;
    provisionedAt: string | null;
  } | null;
  cost: {
    computeTier: string;
    activeHours: number;
    apiRequests: number;
    bandwidthBytes: number;
    lines: ConsoleCostLine[];
    rawUsd: number;
    pricedUsd: number;
    projectedRawUsd: number;
    projectedPricedUsd: number;
  } | null;
  storage: {
    measuredAt: string | null;
    live: boolean;
    totalBytes: number;
    objectCount: number;
    buckets: Array<{
      bucket: string;
      name: string;
      sizeBytes: number;
      objectCount: number;
      createdAt: string;
      public?: boolean;
    }>;
  };
  database: {
    sizeBytes: number | null;
    measuredAt: string | null;
    tables: Array<{
      schema: string;
      name: string;
      totalBytes: number;
      tableBytes: number;
      indexBytes: number;
      estimatedRows: number;
    }>;
    tablesError: string | null;
  };
  history: Array<{
    periodStart: string;
    apiRequests: number;
    bandwidthBytes: number;
    storageBytes: number;
    dbSizeBytes: number;
  }>;
  /** Latest project activity (newest first), also for a project in the trash. */
  activity?: Array<{
    id: string;
    kind: string;
    title: string;
    detail: string | null;
    actorUserId: string | null;
    actorName: string;
    createdAt: string;
  }>;
}

export interface ConsoleStorage {
  measuredAt: string | null;
  refreshing: boolean;
  summary: ConsoleStorageSummary;
  buckets: Array<{
    bucket: string;
    projectId: string | null;
    sizeBytes: number;
    objectCount: number;
    createdAt: string;
    category: StorageCategory;
    project: { id: string; name: string; slug: string; status: string; teamName: string } | null;
  }>;
}
