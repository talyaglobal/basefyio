-- Enable pgvector extension (AI semantic search, RAG, recommendations)
-- Idempotent — safe to run multiple times.
CREATE EXTENSION IF NOT EXISTS vector;

-- Enable pg_trgm for hybrid keyword + semantic search
CREATE EXTENSION IF NOT EXISTS pg_trgm;
