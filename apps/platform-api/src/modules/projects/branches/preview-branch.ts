/**
 * The branch facet of a project, shared by ProjectsService (which returns it on
 * every project) and ProjectBranchService (which creates it). Kept free of
 * service imports so neither side has to import the other.
 */

export type BranchDataMode = 'schema' | 'full';
export type BranchSyncStatus = 'pending' | 'ready' | 'failed';

/** What the dashboard needs to show a project as a preview branch of another. */
export interface PreviewBranch {
  parentProjectId: string;
  parentName: string | null;
  parentSlug: string | null;
  branchName: string;
  dataMode: BranchDataMode | null;
  syncStatus: BranchSyncStatus | null;
  syncError: string | null;
}

/** The branch facet of a project row, or null for an ordinary project. */
export function previewBranchOf(project: {
  parentProjectId?: string | null;
  branchName?: string | null;
  branchDataMode?: string | null;
  branchSyncStatus?: string | null;
  branchSyncError?: string | null;
  parent?: { id: string; name: string; slug: string } | null;
}): PreviewBranch | null {
  if (!project.parentProjectId || !project.branchName) return null;
  return {
    parentProjectId: project.parentProjectId,
    parentName: project.parent?.name ?? null,
    parentSlug: project.parent?.slug ?? null,
    branchName: project.branchName,
    dataMode: (project.branchDataMode as BranchDataMode | null) ?? null,
    syncStatus: (project.branchSyncStatus as BranchSyncStatus | null) ?? null,
    syncError: project.branchSyncError ?? null,
  };
}
