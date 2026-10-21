import {
  PROVIDER_CATALOGUE,
  createProvider,
  endpointFor,
  isPrivateHost,
  modelTag,
  resolvePlatformSettings,
} from './provider-registry';
import { EMBEDDING_PROVIDER_IDS, EmbeddingProviderError } from './embedding-provider';

function config(values: Record<string, unknown> = {}) {
  return { get: (key: string) => values[key] };
}

describe('resolvePlatformSettings', () => {
  it('defaults to OpenAI text-embedding-3-small with no fallback when nothing is set', () => {
    const s = resolvePlatformSettings(config({ 'openai.apiKey': 'sk' }));
    expect(s.primary).toEqual({
      provider: 'openai',
      model: 'text-embedding-3-small',
      baseUrl: null,
      apiKey: 'sk',
      dimensions: null,
    });
    expect(s.fallback).toBeNull();
    expect(s.hostRegion).toBe('');
    expect(s.allowPrivateBaseUrl).toBe(false);
    expect(s.failoverCooldownSec).toBe(60);
    expect(s.reembedMaxRows).toBe(200_000);
    expect(s.warning).toBeNull();
  });

  it('picks the provider default model and the Ollama base URL for EMBEDDING_PROVIDER=ollama', () => {
    const s = resolvePlatformSettings(
      config({ 'embedding.provider': 'ollama', 'embedding.ollama.baseUrl': 'http://ollama:11434/v1' }),
    );
    expect(s.primary.provider).toBe('ollama');
    expect(s.primary.model).toBe('nomic-embed-text');
    expect(s.primary.baseUrl).toBe('http://ollama:11434/v1');
    expect(s.primary.apiKey).toBeNull();
  });

  it('falls back to openai with a warning for an unknown provider', () => {
    const s = resolvePlatformSettings(config({ 'embedding.provider': 'acme' }));
    expect(s.primary.provider).toBe('openai');
    expect(s.warning).toContain('EMBEDDING_PROVIDER="acme"');
  });

  it('reads the fallback and the numeric settings', () => {
    const s = resolvePlatformSettings(
      config({
        'embedding.fallback.provider': 'cohere',
        'embedding.fallback.model': 'embed-v4.0',
        'embedding.cohere.apiKey': 'co',
        'embedding.failoverCooldownSec': '15',
        'embedding.reembedMaxRows': '500',
        'embedding.allowPrivateBaseUrl': true,
        'embedding.hostRegion': 'DE',
        'embedding.dimensions': '1536',
      }),
    );
    expect(s.fallback).toMatchObject({ provider: 'cohere', model: 'embed-v4.0', apiKey: 'co' });
    expect(s.primary.dimensions).toBe(1536);
    expect(s.failoverCooldownSec).toBe(15);
    expect(s.reembedMaxRows).toBe(500);
    expect(s.allowPrivateBaseUrl).toBe(true);
    expect(s.hostRegion).toBe('DE');
  });

  it('ignores an unknown fallback provider with a warning', () => {
    const s = resolvePlatformSettings(config({ 'embedding.fallback.provider': 'nope' }));
    expect(s.fallback).toBeNull();
    expect(s.warning).toContain('EMBEDDING_FALLBACK_PROVIDER="nope"');
  });
});

describe('modelTag', () => {
  it('keeps the bare model for OpenAI so existing rows stay current, prefixes the rest', () => {
    expect(modelTag('openai', 'text-embedding-3-small')).toBe('text-embedding-3-small');
    expect(modelTag('ollama', 'nomic-embed-text')).toBe('ollama/nomic-embed-text');
    expect(modelTag('cohere', 'embed-v4.0')).toBe('cohere/embed-v4.0');
  });

  it('cuts the tag to the 80-character column', () => {
    expect(modelTag('ollama', 'x'.repeat(100))).toHaveLength(80);
  });
});

describe('isPrivateHost', () => {
  it.each([
    'http://127.0.0.1:11434',
    'http://localhost:11434',
    'http://10.0.0.5',
    'http://172.16.3.4',
    'http://192.168.1.2',
    'http://169.254.169.254/latest/meta-data',
    'http://100.64.0.1',
    'http://keycloak:8080',
    'http://ollama.internal',
    'http://printer.local',
    'http://[::1]:11434',
    'http://[fe80::1]',
    'http://[fd00::2]',
    'not a url',
  ])('flags %s as private', (url) => {
    expect(isPrivateHost(url)).toBe(true);
  });

  it.each(['https://api.cohere.com', 'https://203.0.113.7', 'https://embeddings.example.org/v1', 'https://172.32.0.1'])(
    'accepts %s as public',
    (url) => {
      expect(isPrivateHost(url)).toBe(false);
    },
  );
});

describe('PROVIDER_CATALOGUE', () => {
  it('has a data region, a retention statement and a default model for every provider', () => {
    for (const id of EMBEDDING_PROVIDER_IDS) {
      const entry = PROVIDER_CATALOGUE[id];
      expect(entry.id).toBe(id);
      expect(entry.defaultModel).toBeTruthy();
      expect(entry.disclosure.dataRegion.code).toBeTruthy();
      expect(entry.disclosure.retention.length).toBeGreaterThan(20);
      expect(entry.disclosure.usedForTraining).toBe(false);
    }
    expect(PROVIDER_CATALOGUE.ollama.disclosure.selfHosted).toBe(true);
    expect(PROVIDER_CATALOGUE.ollama.requiresApiKey).toBe(false);
  });
});

describe('createProvider / endpointFor', () => {
  it('refuses a key-requiring provider without a key, naming the env var', () => {
    const err = (() => {
      try {
        createProvider({ provider: 'cohere' });
        return null;
      } catch (e) {
        return e as EmbeddingProviderError;
      }
    })();
    expect(err).toBeInstanceOf(EmbeddingProviderError);
    expect(err!.kind).toBe('auth');
    expect(err!.message).toBe('No Cohere API key configured. Set a per-project key or the platform COHERE_API_KEY.');
  });

  it('builds Ollama without a key and strips /v1 from its endpoint', () => {
    const p = createProvider({ provider: 'ollama', baseUrl: 'http://ollama:11434/v1' });
    expect(p.id).toBe('ollama');
    expect(p.model).toBe('nomic-embed-text');
    expect(p.endpoint).toBe('http://ollama:11434');
    expect(endpointFor({ provider: 'ollama', baseUrl: 'http://ollama:11434/v1/' })).toBe('http://ollama:11434');
    expect(endpointFor({ provider: 'openai' })).toBe('https://api.openai.com/v1');
    expect(endpointFor({ provider: 'cohere', baseUrl: 'https://gw/' })).toBe('https://gw');
  });
});
