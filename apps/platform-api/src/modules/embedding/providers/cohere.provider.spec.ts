import { CohereEmbeddingProvider } from './cohere.provider';
import { EmbeddingProviderError } from './embedding-provider';

const fetchMock = jest.fn();

function jsonResponse(status: number, body: unknown) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

function okFor(texts: string[], tokens = 7) {
  return jsonResponse(200, {
    embeddings: { float: texts.map((_, i) => [i, i + 0.5]) },
    meta: { billed_units: { input_tokens: tokens } },
  });
}

beforeEach(() => {
  fetchMock.mockReset();
  (global as any).fetch = fetchMock;
});

describe('CohereEmbeddingProvider', () => {
  it('embeds queries and documents with the matching input_type', async () => {
    fetchMock.mockImplementation(async (_url: string, init: any) => okFor(JSON.parse(init.body).texts));
    const provider = new CohereEmbeddingProvider('embed-v4.0', 'key');

    await provider.embed(['q'], { intent: 'query' });
    await provider.embed(['d'], { intent: 'document' });
    await provider.embed(['d2']);

    const bodies = fetchMock.mock.calls.map(([, init]) => JSON.parse(init.body));
    expect(bodies.map((b) => b.input_type)).toEqual(['search_query', 'search_document', 'search_document']);
    expect(bodies[0]).toMatchObject({ model: 'embed-v4.0', texts: ['q'], embedding_types: ['float'] });
    expect(bodies[0].output_dimension).toBeUndefined();
    expect(fetchMock.mock.calls[0][0]).toBe('https://api.cohere.com/v2/embed');
    expect(fetchMock.mock.calls[0][1].headers.Authorization).toBe('Bearer key');
  });

  it('chunks requests at 96 texts and keeps the order', async () => {
    fetchMock.mockImplementation(async (_url: string, init: any) => okFor(JSON.parse(init.body).texts, 10));
    const texts = Array.from({ length: 200 }, (_, i) => `t${i}`);

    const out = await new CohereEmbeddingProvider('embed-v4.0', 'key').embed(texts);

    expect(fetchMock.mock.calls.map(([, init]) => JSON.parse(init.body).texts.length)).toEqual([96, 96, 8]);
    expect(out.vectors).toHaveLength(200);
    expect(out.vectors[96]).toEqual([0, 0.5]); // first item of the second chunk
    expect(out.tokenCount).toBe(30);
    expect(out.dimensions).toBe(2);
  });

  it('passes output_dimension through when configured', async () => {
    fetchMock.mockImplementation(async (_url: string, init: any) => okFor(JSON.parse(init.body).texts));
    await new CohereEmbeddingProvider('embed-v4.0', 'key', 'https://gateway.example.com/', 1024).embed(['a']);
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).output_dimension).toBe(1024);
    expect(fetchMock.mock.calls[0][0]).toBe('https://gateway.example.com/v2/embed');
  });

  it.each([
    [401, 'auth'],
    [429, 'quota'],
    [422, 'input'],
    [503, 'unknown'],
  ])('maps HTTP %s to kind %s', async (status, kind) => {
    fetchMock.mockResolvedValue(jsonResponse(status, { message: 'upstream said no' }));
    const err = await new CohereEmbeddingProvider('embed-v4.0', 'key').embed(['a']).catch((e) => e);
    expect(err).toBeInstanceOf(EmbeddingProviderError);
    expect(err.kind).toBe(kind);
    expect(err.status).toBe(status);
    expect(err.message).toContain('upstream said no');
  });

  it('rejects a response that is missing vectors', async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, { embeddings: {} }));
    const err = await new CohereEmbeddingProvider('embed-v4.0', 'key').embed(['a']).catch((e) => e);
    expect(err.kind).toBe('unknown');
  });
});
