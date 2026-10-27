import { aiEnabled } from './ai-switch';
import configuration from '../../config/configuration';
import { createProvider } from '../../modules/embedding/providers/provider-registry';

const KEYS = ['AI_ENABLED', 'OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'FAL_KEY', 'ELEVENLABS_API_KEY', 'COHERE_API_KEY', 'OLLAMA_BASE_URL', 'OLLAMA_API_KEY', 'EMBEDDING_ENABLED'];
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const k of KEYS) saved[k] = process.env[k];
  process.env.OPENAI_API_KEY = 'sk-test';
  process.env.ANTHROPIC_API_KEY = 'sk-ant-test';
  process.env.FAL_KEY = 'fal-test';
  process.env.ELEVENLABS_API_KEY = 'el-test';
  process.env.COHERE_API_KEY = 'co-test';
  process.env.OLLAMA_BASE_URL = 'http://ollama.example.test:11434';
  process.env.OLLAMA_API_KEY = 'ol-test';
  delete process.env.EMBEDDING_ENABLED;
});

afterEach(() => {
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

describe('AI_ENABLED', () => {
  it('is on unless set to false — today\'s behaviour', () => {
    delete process.env.AI_ENABLED;
    expect(aiEnabled()).toBe(true);
    process.env.AI_ENABLED = 'true';
    expect(aiEnabled()).toBe(true);
    process.env.AI_ENABLED = 'FALSE';
    expect(aiEnabled()).toBe(false);
  });

  it('keeps every key when on', () => {
    delete process.env.AI_ENABLED;
    const c: any = configuration();
    expect(c.ai.enabled).toBe(true);
    expect(c.openai.apiKey).toBe('sk-test');
    expect(c.marketingAgency.claude.apiKey).toBe('sk-ant-test');
    expect(c.embedding.enabled).toBe(true);
    expect(c.embedding.cohere.apiKey).toBe('co-test');
  });

  it('empties every hosted-model key and switches embeddings off when false', () => {
    process.env.AI_ENABLED = 'false';
    const c: any = configuration();
    expect(c.ai.enabled).toBe(false);
    expect(c.openai.apiKey).toBe('');
    expect(c.marketingAgency.claude.apiKey).toBe('');
    expect(c.marketingAgency.fal.apiKey).toBe('');
    expect(c.marketingAgency.elevenlabs.apiKey).toBe('');
    expect(c.embedding.enabled).toBe(false);
    expect(c.embedding.cohere.apiKey).toBe('');
    expect(c.embedding.ollama.baseUrl).toBe('');
    expect(c.embedding.ollama.apiKey).toBe('');
  });

  it('refuses to build any embedding provider — platform or per-project — when false', () => {
    process.env.AI_ENABLED = 'false';
    expect(() => createProvider({ provider: 'openai', apiKey: 'sk-project-own-key' } as any)).toThrow(/switched off/);
    expect(() => createProvider({ provider: 'cohere', apiKey: 'co-project' } as any)).toThrow(/switched off/);
  });
});
