jest.mock('../../prisma/prisma.service', () => ({ PrismaService: class {} }));
jest.mock('pg', () => ({ Pool: jest.fn() }));

import { BadRequestException } from '@nestjs/common';
import { TenantEmbeddingService } from './tenant-embedding.service';
import { EmbeddingProviderError } from '../embedding/providers/embedding-provider';

/** #24: a project API key is tried with one tiny request before it is stored. */
function build(probe: jest.Mock) {
  const prisma = { project: { update: jest.fn(async () => ({})) } };
  const providers = { forProject: jest.fn((p: any) => ({ config: { provider: 'openai' }, project: p })), probe };
  const svc = new TenantEmbeddingService(prisma as any, { get: () => undefined } as any, providers as any, {} as any);
  (svc as any).getProject = jest.fn(async () => ({ id: 'p1', embeddingProvider: 'openai' }));
  return { svc, prisma, providers };
}

describe('TenantEmbeddingService.setEmbeddingApiKey', () => {
  it('refuses a key the provider rejects, and stores nothing', async () => {
    const probe = jest.fn().mockRejectedValue(new EmbeddingProviderError('openai', 401, 'auth' as any, 'Incorrect API key provided'));
    const { svc, prisma } = build(probe);
    await expect(svc.setEmbeddingApiKey('p1', 'fake')).rejects.toBeInstanceOf(BadRequestException);
    await expect(svc.setEmbeddingApiKey('p1', 'fake')).rejects.toThrow(/did not accept this key.*not saved/);
    expect(prisma.project.update).not.toHaveBeenCalled();
  });

  it('stores a key that works, trimmed, probing with that key', async () => {
    const probe = jest.fn().mockResolvedValue({ dimensions: 1536, model: 'm' });
    const { svc, prisma, providers } = build(probe);
    await svc.setEmbeddingApiKey('p1', '  sk-good  ');
    expect(providers.forProject).toHaveBeenCalledWith(expect.objectContaining({ embeddingApiKey: 'sk-good' }));
    expect(prisma.project.update).toHaveBeenCalledWith({ where: { id: 'p1' }, data: { embeddingApiKey: 'sk-good' } });
  });

  it('clears with null without a probe, and refuses an empty string', async () => {
    const probe = jest.fn();
    const { svc, prisma } = build(probe);
    await svc.setEmbeddingApiKey('p1', null);
    expect(probe).not.toHaveBeenCalled();
    expect(prisma.project.update).toHaveBeenCalledWith({ where: { id: 'p1' }, data: { embeddingApiKey: null } });
    await expect(svc.setEmbeddingApiKey('p1', '   ')).rejects.toBeInstanceOf(BadRequestException);
  });
});
