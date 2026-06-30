import { RagIndexProcessor } from './rag-index.processor';

function build() {
  const repo: any = {
    markJobRunning: jest.fn().mockResolvedValue(undefined),
    markJobCompleted: jest.fn().mockResolvedValue(undefined),
    markJobFailed: jest.fn().mockResolvedValue(undefined),
  };
  const indexer: any = { runJob: jest.fn() };
  const proc = new RagIndexProcessor(repo, indexer);
  return { proc, repo, indexer };
}

const job = (kind = 'INDEX') =>
  ({ data: { jobId: 'j1', projectId: 'p1', kind } }) as any;

describe('RagIndexProcessor', () => {
  it('marks the job RUNNING then COMPLETED on success', async () => {
    const { proc, repo, indexer } = build();
    indexer.runJob.mockResolvedValue({ processedDocs: 2, failedDocs: 0, totalChunks: 5 });
    await proc.process(job());
    expect(repo.markJobRunning).toHaveBeenCalledWith('j1');
    expect(repo.markJobCompleted).toHaveBeenCalledWith('j1', { processedDocs: 2, totalChunks: 5 });
    expect(repo.markJobFailed).not.toHaveBeenCalled();
  });

  it('marks the job FAILED when every document failed and nothing was produced', async () => {
    const { proc, repo, indexer } = build();
    indexer.runJob.mockResolvedValue({ processedDocs: 3, failedDocs: 3, totalChunks: 0 });
    await proc.process(job());
    expect(repo.markJobFailed).toHaveBeenCalledWith('j1', expect.stringContaining('3'));
    expect(repo.markJobCompleted).not.toHaveBeenCalled();
  });

  it('stays COMPLETED on partial success (some docs failed but chunks produced)', async () => {
    const { proc, repo, indexer } = build();
    indexer.runJob.mockResolvedValue({ processedDocs: 3, failedDocs: 1, totalChunks: 4 });
    await proc.process(job());
    expect(repo.markJobCompleted).toHaveBeenCalledWith('j1', { processedDocs: 3, totalChunks: 4 });
    expect(repo.markJobFailed).not.toHaveBeenCalled();
  });

  it('marks FAILED and rethrows on an infrastructure error (so BullMQ retries)', async () => {
    const { proc, repo, indexer } = build();
    indexer.runJob.mockRejectedValue(new Error('db down'));
    await expect(proc.process(job())).rejects.toThrow('db down');
    expect(repo.markJobFailed).toHaveBeenCalledWith('j1', expect.stringContaining('db down'));
  });
});
