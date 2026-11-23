import { describe, expect, it, vi } from 'vitest';
import { describeVectorStatus, runRotatePassword, runVectorAction, type DbAdminApi } from './db-admin';

function stub(over: Partial<DbAdminApi> = {}): DbAdminApi {
  return {
    getEmbeddingStatus: vi.fn().mockResolvedValue({ pgvectorEnabled: true, embeddingCount: 3 }),
    enableEmbeddings: vi.fn().mockResolvedValue({ message: 'pgvector enabled' }),
    disableEmbeddings: vi.fn().mockResolvedValue({ message: 'pgvector disabled' }),
    rotateDbPassword: vi.fn().mockResolvedValue({ password: 'generated-pw' }),
    ...over,
  };
}

describe('db vector', () => {
  it('enables, disables and reads status through the matching routes', async () => {
    const api = stub();
    expect(await runVectorAction(api, 'p1', 'enable')).toMatch(/enabled/);
    expect(api.enableEmbeddings).toHaveBeenCalledWith('p1');
    expect(await runVectorAction(api, 'p1', 'disable')).toMatch(/disabled/);
    expect(api.disableEmbeddings).toHaveBeenCalledWith('p1');
    expect(await runVectorAction(api, 'p1', 'status')).toBe('pgvector is on (3 embeddings stored)');
  });

  it('describes the off and singular cases', () => {
    expect(describeVectorStatus({ pgvectorEnabled: false })).toBe('pgvector is off');
    expect(describeVectorStatus({ pgvectorEnabled: true, embeddingCount: 1 })).toBe('pgvector is on (1 embedding stored)');
    expect(describeVectorStatus({ pgvectorEnabled: true })).toBe('pgvector is on');
  });

  it('does not swallow API failures', async () => {
    const api = stub({ enableEmbeddings: vi.fn().mockRejectedValue(new Error('403')) });
    await expect(runVectorAction(api, 'p1', 'enable')).rejects.toThrow('403');
  });
});

describe('db rotate-password', () => {
  it('lets the server generate a password when none is given', async () => {
    const api = stub();
    expect(await runRotatePassword(api, 'p1')).toBe('generated-pw');
    expect(api.rotateDbPassword).toHaveBeenCalledWith('p1', undefined);
    await runRotatePassword(api, 'p1', '   ');
    expect(api.rotateDbPassword).toHaveBeenLastCalledWith('p1', undefined);
  });

  it('passes an explicit password through trimmed', async () => {
    const api = stub();
    await runRotatePassword(api, 'p1', ' s3cret-value ');
    expect(api.rotateDbPassword).toHaveBeenCalledWith('p1', 's3cret-value');
  });
});
