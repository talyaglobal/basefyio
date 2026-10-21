import { OllamaEmbeddingProvider, normalizeOllamaBaseUrl } from './ollama.provider';
import { EmbeddingProviderError } from './embedding-provider';

const fetchMock = jest.fn();

function jsonResponse(status: number, body: unknown) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

beforeEach(() => {
  fetchMock.mockReset();
  (global as any).fetch = fetchMock;
});

describe('normalizeOllamaBaseUrl', () => {
  it('drops a trailing /v1 and trailing slashes so the agent module URL works unchanged', () => {
    expect(normalizeOllamaBaseUrl('http://ollama:11434/v1')).toBe('http://ollama:11434');
    expect(normalizeOllamaBaseUrl('http://ollama:11434/')).toBe('http://ollama:11434');
    expect(normalizeOllamaBaseUrl('http://ollama:11434/v1/')).toBe('http://ollama:11434');
    expect(normalizeOllamaBaseUrl('http://ollama:11434')).toBe('http://ollama:11434');
  });
});

describe('OllamaEmbeddingProvider', () => {
  it('posts to /api/embed and maps vectors and token counts', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(200, { embeddings: [[1, 2, 3], [4, 5, 6]], prompt_eval_count: 12 }),
    );
    const provider = new OllamaEmbeddingProvider('nomic-embed-text', 'http://ollama:11434/v1');

    const out = await provider.embed(['a', 'b']);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('http://ollama:11434/api/embed');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body)).toEqual({ model: 'nomic-embed-text', input: ['a', 'b'], truncate: true });
    expect(init.headers.Authorization).toBeUndefined();
    expect(out.vectors).toEqual([[1, 2, 3], [4, 5, 6]]);
    expect(out.dimensions).toBe(3);
    expect(out.tokenCount).toBe(12);
    expect(provider.endpoint).toBe('http://ollama:11434');
  });

  it('reports a null token count when the host does not send one', async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, { embeddings: [[1, 2]] }));
    const out = await new OllamaEmbeddingProvider('m').embed(['a']);
    expect(out.tokenCount).toBeNull();
  });

  it('adds a bearer header only when a key is given', async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, { embeddings: [[1]] }));
    await new OllamaEmbeddingProvider('m', null, 'tok').embed(['a']);
    expect(fetchMock.mock.calls[0][1].headers.Authorization).toBe('Bearer tok');
  });

  it('turns a 404 for a missing model into an input error with the pull hint', async () => {
    fetchMock.mockResolvedValue(jsonResponse(404, { error: 'model "nomic-embed-text" not found, try pulling it first' }));
    const err = await new OllamaEmbeddingProvider('nomic-embed-text').embed(['a']).catch((e) => e);
    expect(err).toBeInstanceOf(EmbeddingProviderError);
    expect(err.kind).toBe('input');
    expect(err.status).toBe(404);
    expect(err.message).toContain('ollama pull nomic-embed-text');
  });

  it('maps a refused connection to unavailable', async () => {
    fetchMock.mockRejectedValue(Object.assign(new TypeError('fetch failed'), { cause: { message: 'ECONNREFUSED' } }));
    const err = await new OllamaEmbeddingProvider('m', 'http://down:11434').embed(['a']).catch((e) => e);
    expect(err.kind).toBe('unavailable');
    expect(err.status).toBeUndefined();
    expect(err.message).toContain('down:11434');
    expect(err.message).toContain('ECONNREFUSED');
  });

  it('maps a 500 to unknown with the status', async () => {
    fetchMock.mockResolvedValue(jsonResponse(500, { error: 'boom' }));
    const err = await new OllamaEmbeddingProvider('m').embed(['a']).catch((e) => e);
    expect(err.kind).toBe('unknown');
    expect(err.status).toBe(500);
  });

  it('rejects a response with the wrong number of vectors', async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, { embeddings: [[1]] }));
    const err = await new OllamaEmbeddingProvider('m').embed(['a', 'b']).catch((e) => e);
    expect(err.kind).toBe('unknown');
    expect(err.message).toContain('1 vector(s) for 2 input(s)');
  });
});
