import {
  BadGatewayException,
  BadRequestException,
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../../prisma/prisma.service';
import { decryptField, encryptField, isEncryptionEnabled } from '../../common/crypto/field-crypto';
import {
  AI_PROVIDERS,
  AI_PROVIDER_IDS,
  AiProviderId,
  LlmClient,
  LlmError,
  createLlmClient,
  isAiProviderId,
} from './ai-llm';

/** The model the platform's own key runs, unchanged from before projects could choose. */
export const PLATFORM_PROVIDER: AiProviderId = 'openai';
export const PLATFORM_MODEL = 'gpt-4o-mini';

const KEY_TEST_TIMEOUT_MS = 20_000;

export interface ResolvedLlm {
  client: LlmClient;
  source: 'project' | 'platform';
}

export interface AiAssistantSettingsView {
  /** null = the platform default is in use. */
  provider: AiProviderId | null;
  model: string | null;
  /** Last four characters of the stored key, so the person can tell keys apart. */
  keyHint: string | null;
  updatedAt: string | null;
  platform: { provider: AiProviderId; model: string; available: boolean };
  providers: (typeof AI_PROVIDERS)[AiProviderId][];
}

/**
 * Which model the assistant uses for a project, and with whose key.
 *
 * A project may store its own OpenAI, Gemini or Claude key. The key is tested
 * with one tiny request before it is saved, encrypted at rest, and never sent
 * back to the dashboard — only its last four characters are.
 */
@Injectable()
export class AiSettingsService {
  private readonly logger = new Logger(AiSettingsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {}

  private platformKey(): string {
    return (this.config.get<string>('openai.apiKey') || '').trim();
  }

  /** The platform default, or null when the platform has no key either. */
  platformLlm(): ResolvedLlm | null {
    const key = this.platformKey();
    if (!key) return null;
    return {
      client: createLlmClient({ provider: PLATFORM_PROVIDER, model: PLATFORM_MODEL, apiKey: key }),
      source: 'platform',
    };
  }

  /** The project's own model when it has one, otherwise the platform default. */
  async resolve(projectId?: string | null): Promise<ResolvedLlm | null> {
    if (projectId) {
      const row = await this.prisma.projectAiAssistantSettings.findUnique({ where: { projectId } });
      if (row && isAiProviderId(row.provider)) {
        const apiKey = decryptField(row.apiKey) ?? '';
        if (apiKey && !apiKey.startsWith('enc:v1:')) {
          return {
            client: createLlmClient({ provider: row.provider, model: row.model, apiKey }),
            source: 'project',
          };
        }
        this.logger.warn(`AI assistant key for project ${projectId} cannot be decrypted; using the platform model.`);
      }
    }
    return this.platformLlm();
  }

  async view(projectId: string): Promise<AiAssistantSettingsView> {
    const row = await this.prisma.projectAiAssistantSettings.findUnique({ where: { projectId } });
    const key = row ? decryptField(row.apiKey) ?? '' : '';
    return {
      provider: row && isAiProviderId(row.provider) ? row.provider : null,
      model: row?.model ?? null,
      keyHint: key && !key.startsWith('enc:v1:') ? `…${key.slice(-4)}` : null,
      updatedAt: row?.updatedAt?.toISOString() ?? null,
      platform: { provider: PLATFORM_PROVIDER, model: PLATFORM_MODEL, available: !!this.platformKey() },
      providers: AI_PROVIDER_IDS.map((id) => AI_PROVIDERS[id]),
    };
  }

  /**
   * Save a provider, model and key for the project. The key may be omitted
   * when only the model of the stored provider changes. Returns a warning when
   * the provider accepted the key but reported a rate limit.
   */
  async save(
    projectId: string,
    userId: string,
    input: { provider?: unknown; model?: unknown; apiKey?: unknown; skipValidation?: unknown },
  ): Promise<{ settings: AiAssistantSettingsView; warning: string | null }> {
    if (!isAiProviderId(input.provider)) {
      throw new BadRequestException(`provider must be one of ${AI_PROVIDER_IDS.join(', ')}`);
    }
    const provider = input.provider;
    const info = AI_PROVIDERS[provider];
    const model = typeof input.model === 'string' && input.model.trim() ? input.model.trim() : info.defaultModel;
    if (!/^[\w.:@/-]{1,120}$/.test(model)) {
      throw new BadRequestException('model may only contain letters, digits, ".", ":", "@", "/", "-" and "_"');
    }

    const existing = await this.prisma.projectAiAssistantSettings.findUnique({ where: { projectId } });
    let apiKey = typeof input.apiKey === 'string' ? input.apiKey.trim() : '';
    if (!apiKey) {
      const stored = existing && existing.provider === provider ? decryptField(existing.apiKey) ?? '' : '';
      if (!stored || stored.startsWith('enc:v1:')) {
        throw new BadRequestException({
          code: 'AI_API_KEY_REQUIRED',
          message: `Enter a ${info.name} API key.`,
        });
      }
      apiKey = stored;
    }
    if (/[\s\u0000-\u001f]/.test(apiKey) || apiKey.length > 1000) {
      throw new BadRequestException({
        code: 'AI_API_KEY_INVALID_FORMAT',
        message: 'An API key is a single line without spaces. Paste the key exactly as the provider shows it.',
      });
    }
    if (!isEncryptionEnabled()) {
      throw new ServiceUnavailableException(
        'API keys cannot be stored on this installation because DB_CRED_ENC_KEY is not set.',
      );
    }

    let warning: string | null = null;
    if (input.skipValidation !== true) {
      try {
        await createLlmClient({ provider, model, apiKey }).complete({
          system: 'Reply with the single word OK.',
          turns: [{ role: 'user', content: 'Connection test' }],
          maxTokens: 16,
          signal: AbortSignal.timeout(KEY_TEST_TIMEOUT_MS),
        });
      } catch (err) {
        const e = err instanceof LlmError ? err : new LlmError('unavailable', String((err as any)?.message ?? err));
        if (e.kind === 'auth') {
          throw new BadRequestException({ code: 'AI_API_KEY_REJECTED', message: e.message });
        }
        if (e.kind === 'input') {
          throw new BadRequestException({
            code: 'AI_MODEL_REJECTED',
            message: `${e.message} Check that the model "${model}" exists and your key may use it.`,
          });
        }
        if (e.kind === 'quota') {
          warning = `${info.name} accepted the key but reported a rate limit or exhausted quota: ${e.message}`;
        } else if (e.kind !== 'refusal') {
          throw new BadGatewayException({
            code: 'AI_PROVIDER_UNREACHABLE',
            message: `Could not reach ${info.name} to test the key: ${e.message} Try again, or save it without the test.`,
          });
        }
      }
    }

    const encrypted = encryptField(apiKey) as string;
    await this.prisma.projectAiAssistantSettings.upsert({
      where: { projectId },
      create: { projectId, provider, model, apiKey: encrypted, updatedBy: userId },
      update: { provider, model, apiKey: encrypted, updatedBy: userId },
    });
    return { settings: await this.view(projectId), warning };
  }

  /** Return the project to the platform default and forget its key. */
  async clear(projectId: string): Promise<AiAssistantSettingsView> {
    await this.prisma.projectAiAssistantSettings.deleteMany({ where: { projectId } });
    return this.view(projectId);
  }
}
