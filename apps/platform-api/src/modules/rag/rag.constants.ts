/** EntityType used when RAG chunks are embedded through the shared pipeline. */
export const RAG_CHUNK_ENTITY_TYPE = 'rag_document_chunk' as const;

/** Default search limit when the caller omits it (within the 1–25 bound). */
export const RAG_DEFAULT_SEARCH_LIMIT = 8;

/** Default cosine-distance threshold (tighter than generic search for precision). */
export const RAG_DEFAULT_SEARCH_THRESHOLD = 0.45;
