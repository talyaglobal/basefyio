import { Injectable, Logger } from '@nestjs/common';
import { EmbeddingService } from '../embedding/embedding.service';
import { VectorStoreService } from '../embedding/vector-store.service';
import type { SimilarityResult } from '../embedding/types';

/** Approximate tokens = chars / 4. Used to enforce a context budget. */
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

const RAG_MAX_TOKENS = 1200;
const RAG_MAX_RESULTS = 8;
const RAG_THRESHOLD = 0.45; // cosine distance — tighter than search for precision

interface AiContext {
  projectId?: string;
  projectName?: string;
  tables?: string[];
  page?: string;
  allProjects?: { id: string; name: string }[];
  mode?: string;
}

@Injectable()
export class RagService {
  private readonly logger = new Logger(RagService.name);

  constructor(
    private readonly embeddingService: EmbeddingService,
    private readonly vectorStore: VectorStoreService,
  ) {}

  /**
   * Retrieve relevant context for the given user query and inject it as a
   * formatted context block ready to append to the system prompt.
   *
   * Returns an empty string if no relevant context is found or if
   * embedding is unavailable (graceful degradation).
   */
  async retrieveContext(
    userQuery: string,
    context: AiContext,
  ): Promise<string> {
    try {
      const embedding = await this.embeddingService.generateEmbedding(userQuery);
      if (!embedding) return '';

      const results = await this.vectorStore.findSimilar(embedding, {
        entityTypes: ['project_schema', 'sql_audit_log', 'sql_query_pattern'],
        projectId: context.projectId,
        threshold: RAG_THRESHOLD,
        limit: RAG_MAX_RESULTS,
      });

      if (results.length === 0) return '';

      return this.formatContextBlock(results);
    } catch (err: any) {
      this.logger.warn('RAG retrieval failed', err?.message);
      return '';
    }
  }

  private formatContextBlock(results: SimilarityResult[]): string {
    const chunks: string[] = [];
    let totalTokens = 0;

    for (const result of results) {
      const text = result.text;
      if (!text) continue;

      const label = this.entityLabel(result.entityType as string);
      const line = `[${label}] ${text.trim()}`;
      const lineTokens = estimateTokens(line);

      if (totalTokens + lineTokens > RAG_MAX_TOKENS) break;

      chunks.push(line);
      totalTokens += lineTokens;
    }

    if (chunks.length === 0) return '';

    return (
      `\n\n=== RETRIEVED CONTEXT (from your project data) ===\n` +
      chunks.join('\n') +
      `\n===`
    );
  }

  private entityLabel(entityType: string): string {
    const labels: Record<string, string> = {
      project_schema: 'Schema',
      sql_audit_log: 'Recent SQL',
      sql_query_pattern: 'SQL Pattern',
      project_activity: 'Activity',
      feedback: 'Feedback',
      user_behavior_session: 'Usage',
    };
    return labels[entityType] ?? entityType;
  }
}
