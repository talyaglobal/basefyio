import { Readable } from 'node:stream';
import { RagIndexerService } from './rag-indexer.service';
import { sha256 } from './rag-util';

const BYTES = Buffer.from(
  'Sentence one explains the idea. Sentence two carries it forward. Sentence three concludes.',
);

function build() {
  const storage: any = {
    getObject: jest.fn().mockResolvedValue({ stream: Readable.from(BYTES) }),
  };
  const embedding: any = {
    embedContent: jest.fn().mockResolvedValue('emb-rec'),
  };
  const repo: any = {
    getDocument: jest.fn(),
    listAllDocuments: jest.fn().mockResolvedValue([]),
    listIncompleteDocuments: jest.fn().mockResolvedValue([]),
    upsertChunks: jest.fn().mockResolvedValue(1),
    patchDocument: jest.fn().mockResolvedValue(undefined),
  };
  const activity: any = { append: jest.fn().mockResolvedValue(undefined) };
  const indexer = new RagIndexerService(storage, embedding, repo, activity);
  return { indexer, storage, embedding, repo, activity };
}

const baseDoc = {
  id: 'd1',
  projectId: 'p1',
  bucketName: 'docs',
  objectKey: 'a.txt',
  title: 'A',
  contentType: 'text/plain',
  status: 'PENDING',
  sourceHash: null,
  granularity: 'sentence',
  chunkSize: 1000,
  chunkOverlap: 200,
} as any;

describe('RagIndexerService', () => {
  it('indexes a document: embeds chunks, upserts, marks INDEXED (READY)', async () => {
    const { indexer, embedding, repo, activity } = build();
    const written = await indexer.indexDocument(baseDoc, 'INDEX');

    expect(written).toBeGreaterThan(0);
    expect(embedding.embedContent).toHaveBeenCalled();
    // chunks were embedded with the RAG entity type and project scope
    expect(embedding.embedContent).toHaveBeenCalledWith(
      expect.any(String),
      'rag_document_chunk',
      expect.any(String),
      expect.objectContaining({ projectId: 'p1' }),
    );
    expect(repo.upsertChunks).toHaveBeenCalledWith('d1', 'p1', expect.any(Array));
    // marked PROCESSING then INDEXED with a freshly computed sourceHash
    const statuses = repo.patchDocument.mock.calls.map((c: any[]) => c[1].status);
    expect(statuses).toContain('PROCESSING');
    expect(statuses).toContain('INDEXED');
    const indexedCall = repo.patchDocument.mock.calls.find((c: any[]) => c[1].status === 'INDEXED');
    expect(indexedCall[1].sourceHash).toBe(sha256(BYTES));
    expect(activity.append).toHaveBeenCalled();
  });

  it('is idempotent: unchanged + already INDEXED is skipped', async () => {
    const { indexer, repo } = build();
    const doc = { ...baseDoc, status: 'INDEXED', sourceHash: sha256(BYTES) };
    const written = await indexer.indexDocument(doc, 'INDEX');
    expect(written).toBe(0);
    expect(repo.upsertChunks).not.toHaveBeenCalled();
  });

  it('re-indexes when the source hash changed (STALE path)', async () => {
    const { indexer, repo } = build();
    const doc = { ...baseDoc, status: 'INDEXED', sourceHash: 'old-different-hash' };
    const written = await indexer.indexDocument(doc, 'INDEX');
    expect(written).toBeGreaterThan(0);
    expect(repo.upsertChunks).toHaveBeenCalled();
  });

  it('forced REINDEX runs even when unchanged', async () => {
    const { indexer, repo } = build();
    const doc = { ...baseDoc, status: 'INDEXED', sourceHash: sha256(BYTES) };
    const written = await indexer.indexDocument(doc, 'REINDEX');
    expect(written).toBeGreaterThan(0);
    expect(repo.upsertChunks).toHaveBeenCalled();
  });

  it('marks FAILED and does not throw when the object cannot be read', async () => {
    const { indexer, storage, repo } = build();
    storage.getObject.mockRejectedValueOnce(new Error('NoSuchKey'));
    const written = await indexer.indexDocument(baseDoc, 'INDEX');
    expect(written).toBe(0);
    const failed = repo.patchDocument.mock.calls.find((c: any[]) => c[1].status === 'FAILED');
    expect(failed).toBeTruthy();
    expect(repo.upsertChunks).not.toHaveBeenCalled();
  });

  it('failed reindex of an already-INDEXED doc keeps it INDEXED (chunks stay usable)', async () => {
    const { indexer, embedding, repo } = build();
    embedding.embedContent.mockRejectedValueOnce(new Error('embed boom'));
    const doc = { ...baseDoc, status: 'INDEXED', sourceHash: 'old-hash' };
    const written = await indexer.indexDocument(doc, 'REINDEX');
    expect(written).toBe(0);
    const last = repo.patchDocument.mock.calls.at(-1);
    expect(last[1].status).toBe('INDEXED');
    expect(last[1].error).toContain('embed boom');
    expect(repo.upsertChunks).not.toHaveBeenCalled();
  });

  it('rejects a document that exceeds the max size', async () => {
    const { indexer, storage, repo } = build();
    const big = Buffer.alloc(26 * 1024 * 1024, 0x61); // > 25 MB cap
    storage.getObject.mockResolvedValueOnce({ stream: Readable.from(big) });
    const written = await indexer.indexDocument(baseDoc, 'INDEX');
    expect(written).toBe(0);
    expect(repo.patchDocument.mock.calls.some((c: any[]) => c[1].status === 'FAILED')).toBe(true);
    expect(repo.upsertChunks).not.toHaveBeenCalled();
  });

  describe('runJob target resolution', () => {
    it('REINDEX_INCOMPLETE pulls only the incomplete set', async () => {
      const { indexer, repo } = build();
      await indexer.runJob({ jobId: 'j', projectId: 'p1', kind: 'REINDEX_INCOMPLETE' });
      expect(repo.listIncompleteDocuments).toHaveBeenCalledWith('p1');
      expect(repo.listAllDocuments).not.toHaveBeenCalled();
    });

    it('single-document job resolves that document only', async () => {
      const { indexer, repo } = build();
      repo.getDocument.mockResolvedValueOnce(null);
      await indexer.runJob({ jobId: 'j', projectId: 'p1', kind: 'REINDEX', documentId: 'd1' });
      expect(repo.getDocument).toHaveBeenCalledWith('p1', 'd1');
    });

    it('project-wide REINDEX pulls all documents', async () => {
      const { indexer, repo } = build();
      await indexer.runJob({ jobId: 'j', projectId: 'p1', kind: 'REINDEX' });
      expect(repo.listAllDocuments).toHaveBeenCalledWith('p1');
    });
  });
});
