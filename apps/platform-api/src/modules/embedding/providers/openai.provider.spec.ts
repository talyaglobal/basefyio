const embeddingsCreate = jest.fn();
const ctor = jest.fn();

jest.mock('openai', () => {
  class APIError extends Error {
    constructor(
      readonly status: number | undefined,
      message: string,
    ) {
      super(message);
    }
  }
  const OpenAI = jest.fn().mockImplementation((opts: unknown) => {
    ctor(opts);
    return { embeddings: { create: embeddingsCreate } };
  });
  (OpenAI as any).APIError = APIError;
  return { __esModule: true, default: OpenAI };
});

import OpenAI from 'openai';
import { OpenAiEmbeddingProvider } from './openai.provider';
import { EmbeddingProviderError } from './embedding-provider';

const APIError = (OpenAI as any).APIError;

beforeEach(() => {
  embeddingsCreate.mockReset();
  ctor.mockReset();
});

describe('OpenAiEmbeddingProvider', () => {
  it('uses the default endpoint and sends only model + input by default', async () => {
    embeddingsCreate.mockResolvedValue({
      data: [
        { index: 1, embedding: [2, 2] },
        { index: 0, embedding: [1, 1] },
      ],
      usage: { total_tokens: 9 },
    });
    const provider = new OpenAiEmbeddingProvider('text-embedding-3-small', 'sk');

    const out = await provider.embed(['a', 'b']);

    expect(ctor).toHaveBeenCalledWith({ apiKey: 'sk' });
    expect(embeddingsCreate.mock.calls[0][0]).toEqual({ model: 'text-embedding-3-small', input: ['a', 'b'] });
    expect(out.vectors).toEqual([[1, 1], [2, 2]]); // sorted by index
    expect(out.tokenCount).toBe(9);
    expect(out.dimensions).toBe(2);
    expect(provider.endpoint).toBe('https://api.openai.com/v1');
  });

  it('passes a custom base URL and the dimensions option when set', async () => {
    embeddingsCreate.mockResolvedValue({ data: [{ index: 0, embedding: [1] }], usage: { total_tokens: 1 } });
    const provider = new OpenAiEmbeddingProvider('text-embedding-3-large', 'sk', 'https://gw.example.com/v1/', 1536);

    await provider.embed(['a']);

    expect(ctor).toHaveBeenCalledWith({ apiKey: 'sk', baseURL: 'https://gw.example.com/v1' });
    expect(embeddingsCreate.mock.calls[0][0].dimensions).toBe(1536);
    expect(provider.endpoint).toBe('https://gw.example.com/v1');
  });

  it('cuts inputs at 8000 characters', async () => {
    embeddingsCreate.mockResolvedValue({ data: [{ index: 0, embedding: [1] }], usage: {} });
    await new OpenAiEmbeddingProvider('m', 'sk').embed(['x'.repeat(9000)]);
    expect(embeddingsCreate.mock.calls[0][0].input[0]).toHaveLength(8000);
  });

  it.each([
    [401, 'auth'],
    [403, 'auth'],
    [429, 'quota'],
    [400, 'input'],
    [500, 'unknown'],
    [undefined, 'unavailable'],
  ])('maps APIError status %s to kind %s', async (status, kind) => {
    embeddingsCreate.mockRejectedValue(new APIError(status, 'upstream'));
    const err = await new OpenAiEmbeddingProvider('m', 'sk').embed(['a']).catch((e) => e);
    expect(err).toBeInstanceOf(EmbeddingProviderError);
    expect(err.provider).toBe('openai');
    expect(err.kind).toBe(kind);
    expect(err.status).toBe(status);
  });
});
