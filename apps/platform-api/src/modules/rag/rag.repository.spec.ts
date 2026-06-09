import { BadRequestException } from '@nestjs/common';
import { RagRepository } from './rag.repository';

/** Minimal fake Drizzle handle: db.update(t).set(v).where(cond) -> resolves. */
function repoWithDb() {
  const where = jest.fn().mockResolvedValue(undefined);
  const set = jest.fn().mockReturnValue({ where });
  const db: any = { update: jest.fn().mockReturnValue({ set }) };
  return { repo: new RagRepository(db), db };
}

describe('RagRepository.patchDocument — INDEXED ⇒ sourceHash invariant', () => {
  it('rejects INDEXED when neither the patch nor the existing row has a sourceHash', async () => {
    const { repo, db } = repoWithDb();
    jest.spyOn(repo, 'getDocument').mockResolvedValue({ sourceHash: null } as any);
    await expect(
      repo.patchDocument('p', 'd', { status: 'INDEXED' }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(db.update).not.toHaveBeenCalled();
  });

  it('allows INDEXED when the patch carries a sourceHash (no extra read)', async () => {
    const { repo, db } = repoWithDb();
    const spy = jest.spyOn(repo, 'getDocument');
    await repo.patchDocument('p', 'd', { status: 'INDEXED', sourceHash: 'h' });
    expect(spy).not.toHaveBeenCalled();
    expect(db.update).toHaveBeenCalled();
  });

  it('allows INDEXED when the existing row already has a sourceHash', async () => {
    const { repo, db } = repoWithDb();
    jest.spyOn(repo, 'getDocument').mockResolvedValue({ sourceHash: 'h' } as any);
    await repo.patchDocument('p', 'd', { status: 'INDEXED' });
    expect(db.update).toHaveBeenCalled();
  });

  it('does not gate non-INDEXED patches', async () => {
    const { repo, db } = repoWithDb();
    await repo.patchDocument('p', 'd', { status: 'FAILED', error: 'x' });
    expect(db.update).toHaveBeenCalled();
  });
});
