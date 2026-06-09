export type EntityType =
  | 'sql_audit_log'
  | 'project_schema'
  | 'project_activity'
  | 'feedback'
  | 'sql_query_pattern'
  | 'user_behavior_session'
  // RAG document chunks indexed via the RAG module (reuses this pipeline).
  | 'rag_document_chunk';

export interface EmbedJob {
  entityType: EntityType;
  entityId: string;
  /** The text to embed. */
  content: string;
  projectId?: string;
  teamId?: string;
  /** Extra display fields stored in metadata alongside the chunk text. */
  extraMeta?: Record<string, unknown>;
}

export interface EmbeddingJobPayload {
  jobs: EmbedJob[];
}

export interface SimilarityResult {
  entityType: EntityType;
  entityId: string;
  projectId: string | null;
  teamId: string | null;
  /** Cosine distance (0 = identical, 1 = orthogonal, 2 = opposite). */
  distance: number;
  /** Similarity score = 1 - distance. Higher is more similar. */
  score: number;
  /** The original chunk text stored in embedding_records.metadata.text. */
  text: string | null;
  /** Any extra fields stored alongside the chunk. */
  meta: Record<string, unknown> | null;
}

export interface FindSimilarOptions {
  entityTypes?: EntityType[];
  projectId?: string;
  teamId?: string;
  /** Maximum cosine distance to include (default 0.5). Lower = stricter. */
  threshold?: number;
  limit?: number;
}
