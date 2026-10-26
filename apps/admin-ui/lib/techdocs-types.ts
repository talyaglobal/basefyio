/** The root console's technical documentation, as GET /api/admin/console/techdocs returns it. */
export interface TechDocSummary {
  slug: string;
  title: string;
  section: string;
  sortOrder: number;
  summary: string;
  bytes: number;
  sourceCommit: string | null;
  updatedAt: string;
}

export interface TechDocPage extends TechDocSummary {
  body: string;
}
