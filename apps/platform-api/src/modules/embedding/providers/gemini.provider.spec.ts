import { GeminiEmbeddingProvider } from './gemini.provider';
import { EmbeddingProviderError } from './embedding-provider';

const fetchMock = jest.fn();

function jsonResponse(status: number, body: unknown) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

/** One unit-length vector per request, so normalization leaves the values alone. */
function okFor(requests: unknown[]) {
  return jsonResponse(200, {
    embeddings: requests.map((_, i) => ({ values: i % 2 === 0 ? [1, 0] : [0, 1] })),
  });
}

beforeEach(() => {
  fetchMock.mockReset();
  (global as any).fetch = fetchMock;
});

describe('GeminiEmbeddingProvider', () => {
  it('embeds queries and documents with the matching task type, at 1536 dimensions by default', async () => {
    fetchMock.mockImplementation(async (_url: string, init: any) => okFor(JSON.parse(init.body).requests));
    const provider = new GeminiEmbeddingProvider('gemini-embedding-001', 'key');

    await provider.embed(['q'], { intent: 'query' });
    await provider.embed(['d'], { intent: 'document' });
    await provider.embed(['d2']);

    const bodies = fetchMock.mock.calls.map(([, init]) => JSON.parse(init.body));
    expect(bodies.map((b) => b.requests[0].taskType)).toEqual([
      'RETRIEVAL_QUERY',
      'RETRIEVAL_DOCUMENT',
      'RETRIEVAL_DOCUMENT',
    ]);
    expect(bodies[0].requests[0]).toEqual({
      model: 'models/gemini-embedding-001',
      content: { parts: [{ text: 'q' }] },
      taskType: 'RETRIEVAL_QUERY',
      outputDimensionality: 1536,
    });
    expect(fetchMock.mock.calls[0][0]).toBe(
      'https://generativelanguage.googleapis.com/v1beta/models/gemini-embedding-001:batchEmbedContents',
    );
    expect(fetchMock.mock.calls[0][1].headers['x-goog-api-key']).toBe('key');
    expect(fetchMock.mock.calls[0][1].headers.Authorization).toBeUndefined();
  });

  it('chunks requests at 100 texts and keeps the order', async () => {
    fetchMock.mockImplementation(async (_url: string, init: any) => okFor(JSON.parse(init.body).requests));
    const texts = Array.from({ length: 250 }, (_, i) => `t${i}`);

    const out = await new GeminiEmbeddingProvider('gemini-embedding-001', 'key').embed(texts);

    expect(fetchMock.mock.calls.map(([, init]) => JSON.parse(init.body).requests.length)).toEqual([100, 100, 50]);
    expect(out.vectors).toHaveLength(250);
    expect(out.vectors[101]).toEqual([0, 1]); // second item of the second chunk
    expect(out.tokenCount).toBeNull();
    expect(out.dimensions).toBe(2);
  });

  it('normalizes vectors to unit length', async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, { embeddings: [{ values: [3, 4] }] }));
    const out = await new GeminiEmbeddingProvider('gemini-embedding-001', 'key').embed(['a']);
    expect(out.vectors[0][0]).toBeCloseTo(0.6);
    expect(out.vectors[0][1]).toBeCloseTo(0.8);
  });

  it('honors a configured width, a custom endpoint and a "models/" prefix', async () => {
    fetchMock.mockImplementation(async (_url: string, init: any) => okFor(JSON.parse(init.body).requests));
    await new GeminiEmbeddingProvider('models/gemini-embedding-001', 'key', 'https://gw.example.com/v1beta/', 768).embed(['a']);
    expect(fetchMock.mock.calls[0][0]).toBe('https://gw.example.com/v1beta/models/gemini-embedding-001:batchEmbedContents');
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).requests[0].outputDimensionality).toBe(768);
  });

  it('sends no output width for other models unless one is configured', async () => {
    fetchMock.mockImplementation(async (_url: string, init: any) => okFor(JSON.parse(init.body).requests));
    await new GeminiEmbeddingProvider('text-embedding-004', 'key').embed(['a']);
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).requests[0].outputDimensionality).toBeUndefined();
  });

  it('maps an invalid key (HTTP 400 API_KEY_INVALID) to an auth error', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(400, {
        error: { code: 400, message: 'API key not valid. Please pass a valid API key.', status: 'INVALID_ARGUMENT' },
      }),
    );
    const err = await new GeminiEmbeddingProvider('gemini-embedding-001', 'bad').embed(['a']).catch((e) => e);
    expect(err).toBeInstanceOf(EmbeddingProviderError);
    expect(err.kind).toBe('auth');
    expect(err.provider).toBe('gemini');
    expect(err.message).toContain('API key not valid');
  });

  it('keeps other 400s as input errors and 429 as quota', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(400, { error: { code: 400, message: 'models/nope is not found', status: 'INVALID_ARGUMENT' } }),
    );
    const input = await new GeminiEmbeddingProvider('nope', 'key').embed(['a']).catch((e) => e);
    expect(input.kind).toBe('input');

    fetchMock.mockResolvedValueOnce(jsonResponse(429, { error: { message: 'Resource has been exhausted' } }));
    const quota = await new GeminiEmbeddingProvider('gemini-embedding-001', 'key').embed(['a']).catch((e) => e);
    expect(quota.kind).toBe('quota');
  });

  it('reports a network failure as unavailable', async () => {
    fetchMock.mockRejectedValue(new TypeError('fetch failed'));
    const err = await new GeminiEmbeddingProvider('gemini-embedding-001', 'key').embed(['a']).catch((e) => e);
    expect(err.kind).toBe('unavailable');
    expect(err.message).toContain('generativelanguage.googleapis.com');
  });

  it('refuses a response with the wrong number of vectors', async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, { embeddings: [{ values: [1, 0] }] }));
    const err = await new GeminiEmbeddingProvider('gemini-embedding-001', 'key').embed(['a', 'b']).catch((e) => e);
    expect(err).toBeInstanceOf(EmbeddingProviderError);
    expect(err.message).toContain('1 vector(s) for 2 input(s)');
  });
});
