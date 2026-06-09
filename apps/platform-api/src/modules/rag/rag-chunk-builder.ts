/**
 * Pure builder that turns raw chunker output into persistable chunk rows,
 * embedding each chunk through an injected callback and threading the
 * prev-chunk chain. No NestJS / Drizzle imports, so it is unit-testable in
 * isolation (the row shape mirrors the Drizzle NewRagChunk insert type).
 */
import { estimateTokens, type RawChunk } from './rag-chunker';
import { sha256 } from './rag-util';

export interface RagChunkRow {
  id: string;
  documentId: string;
  projectId: string;
  chunkIndex: number;
  content: string;
  contentHash: string;
  startOffset: number;
  endOffset: number;
  overlapChars: number;
  tokenCount: number;
  prevChunkId: string | null;
  embeddingRecordId: string | null;
}

export interface BuildChunkRowsParams {
  documentId: string;
  projectId: string;
  rawChunks: RawChunk[];
  /** Generate a unique chunk id. */
  genId: () => string;
  /**
   * Embed a chunk and return its embedding_records id (or null when embeddings
   * are unavailable). Called once per chunk, in order.
   */
  embed: (
    content: string,
    chunkId: string,
    chunkIndex: number,
  ) => Promise<string | null>;
}

export async function buildChunkRows(
  params: BuildChunkRowsParams,
): Promise<RagChunkRow[]> {
  const rows: RagChunkRow[] = [];
  let prevChunkId: string | null = null;

  for (const rc of params.rawChunks) {
    const id = params.genId();
    const embeddingRecordId = await params.embed(rc.content, id, rc.index);
    rows.push({
      id,
      documentId: params.documentId,
      projectId: params.projectId,
      chunkIndex: rc.index,
      content: rc.content,
      contentHash: sha256(rc.content),
      startOffset: rc.startOffset,
      endOffset: rc.endOffset,
      overlapChars: rc.overlapChars,
      tokenCount: estimateTokens(rc.content),
      prevChunkId,
      embeddingRecordId,
    });
    prevChunkId = id;
  }

  return rows;
}
