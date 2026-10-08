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

export interface ConsolePlanTeam {
  id: string;
  name: string;
  slug: string;
  ownerEmail: string | null;
  status: string;
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
  paying: number;
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
    projects: { active: number; paused: number; deactivated: number; deleted: number };
  };
  money: {
    mrrUsd: number;
    actualMonthlyBillUsd: number;
    allocatedRawUsd: number;
    allocatedPricedUsd: number;
    marginVsBillUsd: number;
    recoveryRatio: number;
    markup: number;
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
