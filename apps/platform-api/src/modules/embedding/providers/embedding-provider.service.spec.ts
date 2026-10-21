import { BadRequestException } from '@nestjs/common';
import {
  EmbeddingProviderService,
  fitDimensions,
  type ResolvedProvider,
} from './embedding-provider.service';
import { EmbeddingProvider, EmbeddingProviderError } from './embedding-provider';

const fetchMock = jest.fn();

function config(values: Record<string, unknown> = {}) {
  return { get: (key: string) => values[key] } as any;
}

function fakeProvider(embed: jest.Mock, id: 'openai' | 'ollama' | 'cohere' = 'openai'): EmbeddingProvider {
  return { id, model: 'fake-model', endpoint: 'https://fake.example.com', embed } as EmbeddingProvider;
}

function resolvedWith(
  provider: EmbeddingProvider,
  fallback: ResolvedProvider['fallback'] = null,
): ResolvedProvider {
  return {
    provider,
    config: { provider: provider.id, model: provider.model },
    tag: provider.model,
    source: 'platform',
    keySource: 'platform',
    fallback,
    endpointIsPlatformHost: true,
  };
}

function ollamaOk(dims = 3) {
  return {
    ok: true,
    status: 200,
    text: async () => JSON.stringify({ embeddings: [Array.from({ length: dims }, (_, i) => i + 1)], prompt_eval_count: 2 }),
  } as unknown as Response;
}

const silence = (svc: EmbeddingProviderService) => {
  const logger = (svc as any).logger;
  jest.spyOn(logger, 'error').mockImplementation(() => undefined);
  jest.spyOn(logger, 'warn').mockImplementation(() => undefined);
  jest.spyOn(logger, 'log').mockImplementation(() => undefined);
  return logger;
};

beforeEach(() => {
  fetchMock.mockReset();
  (global as any).fetch = fetchMock;
});

describe('fitDimensions', () => {
  it('leaves matching widths alone', () => {
    const v = [[1, 2, 3]];
    expect(fitDimensions(v, 3, 't')).toEqual({ vectors: v, padded: false });
    expect(fitDimensions(v, null, 't')).toEqual({ vectors: v, padded: false });
  });

  it('zero-pads narrower vectors and preserves cosine similarity', () => {
    const a = [0.3, 0.4, 0.5];
    const b = [0.1, 0.9, 0.2];
    const cos = (x: number[], y: number[]) => {
      const dot = x.reduce((s, xi, i) => s + xi * y[i], 0);
      const n = (v: number[]) => Math.sqrt(v.reduce((s, vi) => s + vi * vi, 0));
      return dot / (n(x) * n(y));
    };
    const { vectors, padded } = fitDimensions([a, b], 8, 'ollama/nomic', 'ollama');
    expect(padded).toBe(true);
    expect(vectors[0]).toHaveLength(8);
    expect(vectors[0].slice(0, 3)).toEqual(a);
    expect(vectors[0].slice(3)).toEqual([0, 0, 0, 0, 0]);
    expect(Math.abs(cos(vectors[0], vectors[1]) - cos(a, b))).toBeLessThan(1e-12);
  });

  it('refuses vectors wider than the column with a message naming both widths', () => {
    expect(() => fitDimensions([[1, 2, 3, 4]], 3, 'cohere/x', 'cohere')).toThrow(/4-dimensional .* holds 3/);
    try {
      fitDimensions([[1, 2, 3, 4]], 3, 'cohere/x', 'cohere');
    } catch (e) {
      expect(e).toBeInstanceOf(EmbeddingProviderError);
      expect((e as EmbeddingProviderError).kind).toBe('input');
      expect((e as EmbeddingProviderError).provider).toBe('cohere');
    }
  });
});

describe('EmbeddingProviderService.embed failover', () => {
  const fallbackCfg = { provider: 'ollama' as const, model: 'nomic-embed-text', baseUrl: 'http://fallback:11434' };

  it('uses the fallback once the primary fails with an auth error, and logs it', async () => {
    const svc = new EmbeddingProviderService(config({ 'embedding.failoverCooldownSec': '60' }));
    const logger = silence(svc);
    const primary = jest.fn().mockRejectedValue(new EmbeddingProviderError('openai', 401, 'auth', 'bad key'));
    fetchMock.mockResolvedValue(ollamaOk(3));

    const out = await svc.embed(resolvedWith(fakeProvider(primary), fallbackCfg), ['a'], { targetDimensions: 3 });

    expect(primary).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(out.usedFallback).toBe(true);
    expect(out.tag).toBe('ollama/nomic-embed-text');
    expect(out.vectors).toEqual([[1, 2, 3]]);
    expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('using fallback ollama/nomic-embed-text'));
  });

  it('skips the primary for the cooldown, then tries it again', async () => {
    const svc = new EmbeddingProviderService(config({ 'embedding.failoverCooldownSec': '0.01' }));
    silence(svc);
    const primary = jest
      .fn()
      .mockRejectedValueOnce(new EmbeddingProviderError('openai', 503, 'unknown', 'down'))
      .mockResolvedValue({ vectors: [[9, 9, 9]], tokenCount: 1, model: 'fake-model', dimensions: 3 });
    fetchMock.mockResolvedValue(ollamaOk(3));
    const resolved = resolvedWith(fakeProvider(primary), fallbackCfg);

    await svc.embed(resolved, ['a']); // primary fails → fallback, circuit opens
    await svc.embed(resolved, ['b']); // inside cooldown → straight to fallback
    expect(primary).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);

    await new Promise((r) => setTimeout(r, 25));
    const out = await svc.embed(resolved, ['c']); // cooldown over → primary again
    expect(primary).toHaveBeenCalledTimes(2);
    expect(out.usedFallback).toBe(false);
    expect(out.vectors).toEqual([[9, 9, 9]]);
  });

  it('never fails over on a rejected input', async () => {
    const svc = new EmbeddingProviderService(config());
    silence(svc);
    const primary = jest.fn().mockRejectedValue(new EmbeddingProviderError('openai', 400, 'input', 'too long'));

    await expect(svc.embed(resolvedWith(fakeProvider(primary), fallbackCfg), ['a'])).rejects.toThrow('too long');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rethrows when no fallback is configured', async () => {
    const svc = new EmbeddingProviderService(config());
    silence(svc);
    const primary = jest.fn().mockRejectedValue(new EmbeddingProviderError('openai', 429, 'quota', 'slow down'));

    await expect(svc.embed(resolvedWith(fakeProvider(primary)), ['a'])).rejects.toThrow('slow down');
  });

  it('pads to the target width and reports the native width', async () => {
    const svc = new EmbeddingProviderService(config());
    silence(svc);
    const primary = jest.fn().mockResolvedValue({ vectors: [[1, 2]], tokenCount: null, model: 'fake-model', dimensions: 2 });

    const out = await svc.embed(resolvedWith(fakeProvider(primary)), ['a'], { targetDimensions: 5 });

    expect(out.vectors).toEqual([[1, 2, 0, 0, 0]]);
    expect(out.padded).toBe(true);
    expect(out.nativeDimensions).toBe(2);
    expect(out.dimensions).toBe(2);
  });
});

describe('EmbeddingProviderService.probe', () => {
  it('learns the width from one request and caches it per endpoint and model', async () => {
    const svc = new EmbeddingProviderService(config());
    const embed = jest.fn().mockResolvedValue({ vectors: [[1, 2, 3, 4]], tokenCount: 1, model: 'fake-model', dimensions: 4 });
    const resolved = resolvedWith(fakeProvider(embed));

    expect(await svc.probe(resolved)).toEqual({ dimensions: 4, model: 'fake-model' });
    expect(await svc.dimensionsFor(resolved)).toBe(4);
    expect(embed).toHaveBeenCalledTimes(1);
    expect(embed.mock.calls[0][1]).toMatchObject({ intent: 'query' });
  });

  it('returns null from dimensionsFor when the provider cannot be reached', async () => {
    const svc = new EmbeddingProviderService(config());
    const embed = jest.fn().mockRejectedValue(new EmbeddingProviderError('openai', undefined, 'unavailable', 'down'));
    expect(await svc.dimensionsFor(resolvedWith(fakeProvider(embed)))).toBeNull();
  });
});

describe('EmbeddingProviderService.describeProject / forProject', () => {
  const base = { 'openai.apiKey': 'sk-platform', 'embedding.cohere.apiKey': '', 'embedding.ollama.baseUrl': 'http://ollama:11434' };

  it('inherits the platform provider and prefers the project key, dropping the platform fallback', () => {
    const svc = new EmbeddingProviderService(
      config({ ...base, 'embedding.fallback.provider': 'ollama' }),
    );
    const inherited = svc.describeProject({ embeddingProvider: null, embeddingApiKey: null });
    expect(inherited.config).toMatchObject({ provider: 'openai', model: 'text-embedding-3-small', apiKey: 'sk-platform' });
    expect(inherited.keySource).toBe('platform');
    expect(inherited.source).toBe('platform');
    expect(inherited.fallback).toMatchObject({ provider: 'ollama' });

    const withKey = svc.describeProject({ embeddingProvider: null, embeddingApiKey: 'sk-project' });
    expect(withKey.config.apiKey).toBe('sk-project');
    expect(withKey.keySource).toBe('project');
    expect(withKey.fallback).toBeNull();

    expect(svc.forProject({ embeddingProvider: null, embeddingApiKey: 'sk-project' }).provider.id).toBe('openai');
  });

  it('refuses a key-requiring project provider without any key, naming the env var', () => {
    const svc = new EmbeddingProviderService(config(base));
    expect(() => svc.forProject({ embeddingProvider: 'cohere' })).toThrow(BadRequestException);
    expect(() => svc.forProject({ embeddingProvider: 'cohere' })).toThrow(/COHERE_API_KEY/);
  });

  it('builds a project Ollama without a key, on the platform host unless a baseUrl is set', () => {
    const svc = new EmbeddingProviderService(config(base));
    const onPlatform = svc.describeProject({ embeddingProvider: 'ollama', embeddingModel: ' mxbai-embed-large ' });
    expect(onPlatform.config).toMatchObject({ provider: 'ollama', model: 'mxbai-embed-large', baseUrl: 'http://ollama:11434', apiKey: null });
    expect(onPlatform.tag).toBe('ollama/mxbai-embed-large');
    expect(onPlatform.keySource).toBe('none'); // no key anywhere — fine, Ollama needs none
    expect(onPlatform.endpointIsPlatformHost).toBe(true);
    expect(onPlatform.source).toBe('project');

    const remote = svc.describeProject({ embeddingProvider: 'ollama', embeddingBaseUrl: 'https://ollama.customer.example' });
    expect(remote.endpointIsPlatformHost).toBe(false);
    expect(svc.forProject({ embeddingProvider: 'ollama' }).provider.endpoint).toBe('http://ollama:11434');
  });

  it('uses the platform key of the chosen provider when the project has none', () => {
    const svc = new EmbeddingProviderService(config({ ...base, 'embedding.cohere.apiKey': 'co-platform' }));
    const desc = svc.describeProject({ embeddingProvider: 'cohere' });
    expect(desc.config.apiKey).toBe('co-platform');
    expect(desc.keySource).toBe('platform');
  });
});

describe('EmbeddingProviderService.platform', () => {
  it('returns null without a key and does not throw', () => {
    const svc = new EmbeddingProviderService(config());
    expect(svc.platform()).toBeNull();
    expect(svc.describePlatform().keySource).toBe('none');
  });

  it('warns when the fallback is another vector space', () => {
    const svc = new EmbeddingProviderService(
      config({ 'openai.apiKey': 'sk', 'embedding.fallback.provider': 'ollama' }),
    );
    const logger = silence(svc);
    expect(svc.platform()?.tag).toBe('text-embedding-3-small');
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('different vector space'));
  });
});
