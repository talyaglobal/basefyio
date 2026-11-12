import { IsBoolean, IsIn, IsOptional, IsString, MaxLength } from 'class-validator';
import {
  EMBEDDING_PROVIDER_IDS,
  type EmbeddingProviderId,
} from '../../embedding/providers/embedding-provider';

/** Body of POST /projects/:projectId/embeddings/api-key. */
export class SetEmbeddingApiKeyDto {
  /** The per-project key; null (or empty) clears it so the platform key is used again. */
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  apiKey?: string | null;

  /**
   * The provider the key is for, when it is not the one the project uses now
   * (the dashboard sends the provider selected in the form, so a key can be
   * checked before the provider switch that needs it). Omitted = the project's
   * current configuration; null = the platform default provider.
   */
  @IsOptional()
  @IsIn(EMBEDDING_PROVIDER_IDS as readonly string[])
  provider?: EmbeddingProviderId | null;

  /** Model to test with when `provider` is given. Empty = the provider's default. */
  @IsOptional()
  @IsString()
  @MaxLength(120)
  model?: string | null;

  /** Endpoint to test against when `provider` is given. Empty = the provider's own. */
  @IsOptional()
  @IsString()
  @MaxLength(500)
  baseUrl?: string | null;

  /**
   * Store the key without the test request. Meant for a provider that cannot be
   * reached right now; the dashboard only offers it after an "unreachable" or
   * "test request refused" result, never after the provider rejected the key.
   */
  @IsOptional()
  @IsBoolean()
  skipValidation?: boolean;
}
