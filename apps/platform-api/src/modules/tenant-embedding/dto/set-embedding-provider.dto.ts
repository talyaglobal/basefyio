import { IsBoolean, IsIn, IsOptional, IsString, MaxLength } from 'class-validator';
import {
  EMBEDDING_PROVIDER_IDS,
  type EmbeddingProviderId,
} from '../../embedding/providers/embedding-provider';

/** Body of PUT /projects/:projectId/embeddings/provider. */
export class SetEmbeddingProviderDto {
  /** openai | ollama | cohere; null (or omitted) returns the project to the platform default. */
  @IsOptional()
  @IsIn(EMBEDDING_PROVIDER_IDS as readonly string[])
  provider?: EmbeddingProviderId | null;

  /** Model id at the provider. Empty = the provider's default model. */
  @IsOptional()
  @IsString()
  @MaxLength(120)
  model?: string | null;

  /** Custom endpoint (OpenAI-compatible gateway, project-owned Ollama). Empty = provider default. */
  @IsOptional()
  @IsString()
  @MaxLength(500)
  baseUrl?: string | null;

  /** Confirm re-embedding the vectors this project already holds when the model changes. */
  @IsOptional()
  @IsBoolean()
  reembed?: boolean;
}
