import { buildChunkRows } from './rag-chunk-builder';
import { chunk } from './rag-chunker';

describe('buildChunkRows', () => {
  const text = Array.from(
    { length: 30 },
    (_, i) => `Sentence ${i} carries meaning forward to the next.`,
  ).join(' ');

  it('threads the prev-chunk chain and embeds each chunk once', async () => {
    const raw = chunk(text, { chunkSize: 200, chunkOverlap: 50, granularity: 'sentence' });
    let n = 0;
    const embed = jest.fn(async (_c: string, id: string) => `emb-${id}`);
    const rows = await buildChunkRows({
      documentId: 'doc1',
      projectId: 'projA',
      rawChunks: raw,
      genId: () => `c${n++}`,
      embed,
    });

    expect(rows).toHaveLength(raw.length);
    expect(rows[0].prevChunkId).toBeNull();
    for (let i = 1; i < rows.length; i++) {
      expect(rows[i].prevChunkId).toBe(rows[i - 1].id);
    }
    expect(embed).toHaveBeenCalledTimes(raw.length);
    expect(rows.every((r) => r.projectId === 'projA' && r.documentId === 'doc1')).toBe(true);
    expect(rows.every((r) => r.contentHash.length === 64)).toBe(true);
    expect(rows.every((r) => r.embeddingRecordId === `emb-${r.id}`)).toBe(true);
    expect(rows.every((r) => r.tokenCount > 0 && r.endOffset > r.startOffset)).toBe(true);
  });

  it('tolerates a null embedding record (graceful when embeddings unavailable)', async () => {
    const raw = chunk('one sentence only.', { chunkSize: 200, chunkOverlap: 0 });
    const rows = await buildChunkRows({
      documentId: 'd',
      projectId: 'p',
      rawChunks: raw,
      genId: () => 'x',
      embed: async () => null,
    });
    expect(rows[0].embeddingRecordId).toBeNull();
  });
});
