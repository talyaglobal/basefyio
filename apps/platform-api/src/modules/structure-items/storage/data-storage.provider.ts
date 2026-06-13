export interface InsertRowInput {
  structureId: string;
  projectId: string;
  data: Record<string, unknown>;
}

export interface GetRowInput {
  structureId: string;
  projectId: string;
  itemId: string;
}

export interface ListRowsInput {
  structureId: string;
  projectId: string;
  limit: number;
  cursor?: string;
}

export interface UpdateRowInput {
  structureId: string;
  projectId: string;
  itemId: string;
  data: Record<string, unknown>;
}

export interface DeleteRowInput {
  structureId: string;
  projectId: string;
  itemId: string;
}

export interface ExecuteQueryInput {
  structureId: string;
  projectId: string;
  query: string;
  params?: unknown[];
}

export interface StoredRow {
  id: string;
  data: Record<string, unknown>;
  createdAt: Date;
  updatedAt: Date;
}

export interface PaginatedRows {
  data: StoredRow[];
  nextCursor: string | null;
  total: number;
}

export interface QueryResult {
  rows: Record<string, unknown>[];
  rowCount: number;
}

export interface DataStorageProvider {
  insertRow(input: InsertRowInput): Promise<StoredRow>;
  getRow(input: GetRowInput): Promise<StoredRow | null>;
  listRows(input: ListRowsInput): Promise<PaginatedRows>;
  updateRow(input: UpdateRowInput): Promise<StoredRow>;
  deleteRow(input: DeleteRowInput): Promise<void>;
  executeQuery?(input: ExecuteQueryInput): Promise<QueryResult>;
}
