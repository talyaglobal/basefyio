import { RagEmbeddingGcService } from './rag-embedding-gc.service';

function build() {
  const prisma: any = {
    $queryRawUnsafe: jest.fn(),
    embeddingRecord: { deleteMany: jest.fn().mockResolvedValue({ count: 0 }) },
  };
  return { svc: new RagEmbeddingGcService(prisma), prisma };
}

describe('RagEmbeddingGcService', () => {
  it('finds orphans via a LEFT JOIN of embedding_records against rag_chunks', async () => {
    const { svc, prisma } = build();
    prisma.$queryRawUnsafe.mockResolvedValue([
      { record_id: 'r1', chunk_id: 'c1' },
    ]);
    const orphans = await svc.findOrphans();
    const sql = prisma.$queryRawUnsafe.mock.calls[0][0] as string;
    expect(sql).toContain('embedding_records');
    expect(sql).toContain('LEFT JOIN rag_chunks');
    expect(sql).toContain('rc.id IS NULL');
    // entity type bound as the first parameter
    expect(prisma.$queryRawUnsafe.mock.calls[0][1]).toBe('rag_document_chunk');
    expect(orphans).toEqual([{ recordId: 'r1', chunkId: 'c1' }]);
  });

  it('dry-run reports orphans without deleting', async () => {
    const { svc, prisma } = build();
    prisma.$queryRawUnsafe.mockResolvedValue([
      { record_id: 'r1', chunk_id: 'c1' },
      { record_id: 'r2', chunk_id: 'c2' },
    ]);
    const res = await svc.sweep({ dryRun: true });
    expect(res).toMatchObject({ orphans: 2, deleted: 0, dryRun: true });
    expect(res.sample).toHaveLength(2);
    expect(prisma.embeddingRecord.deleteMany).not.toHaveBeenCalled();
  });

  it('deletes orphaned embeddings left by a failed upsertChunks (embeddings written, chunks not inserted)', async () => {
    const { svc, prisma } = build();
    // Simulate: embeddings exist for c1/c2 but rag_chunks insert rolled back.
    prisma.$queryRawUnsafe.mockResolvedValue([
      { record_id: 'r1', chunk_id: 'c1' },
      { record_id: 'r2', chunk_id: 'c2' },
    ]);
    prisma.embeddingRecord.deleteMany.mockResolvedValue({ count: 2 });
    const res = await svc.sweep({});
    expect(res.deleted).toBe(2);
    expect(prisma.embeddingRecord.deleteMany).toHaveBeenCalledWith({
      where: { entityType: 'rag_document_chunk', entityId: { in: ['c1', 'c2'] } },
    });
  });

  it('scopes the orphan query to a project when projectId is given', async () => {
    const { svc, prisma } = build();
    prisma.$queryRawUnsafe.mockResolvedValue([]);
    await svc.findOrphans({ projectId: 'p1' });
    const [sql, ...params] = prisma.$queryRawUnsafe.mock.calls[0];
    expect(sql).toContain('er.project_id =');
    expect(params).toContain('p1');
  });
});
