import { BadRequestException } from '@nestjs/common';
import { FeedbackService } from './feedback.service';

function make(feedback: Record<string, unknown>) {
  const prisma = {
    feedback: { findUnique: jest.fn().mockResolvedValue(feedback), update: jest.fn() },
    user: { findUnique: jest.fn().mockResolvedValue({ role: 'ROOT' }) },
  };
  const service = new FeedbackService(prisma as any, {} as any, {} as any, {} as any, {} as any);
  return { service, prisma };
}

describe('feedback edits', () => {
  it('refuses a status change on a deleted feedback', async () => {
    const { service, prisma } = make({ id: 'f', userId: 'u', deletedAt: new Date(), status: 'CLOSED' });
    await expect(service.updateStatus('root', 'f', 'OPEN' as any)).rejects.toBeInstanceOf(BadRequestException);
    expect(prisma.feedback.update).not.toHaveBeenCalled();
  });

  it('refuses an edit of a deleted feedback', async () => {
    const { service } = make({ id: 'f', userId: 'u', deletedAt: new Date(), description: 'x' });
    await expect(service.updateFeedback('root', 'f', { title: 't' })).rejects.toBeInstanceOf(BadRequestException);
  });

  it('refuses to blank an existing description', async () => {
    const { service, prisma } = make({ id: 'f', userId: 'u', deletedAt: null, description: 'text', title: 't' });
    await expect(service.updateFeedback('root', 'f', { description: '   ' })).rejects.toBeInstanceOf(BadRequestException);
    expect(prisma.feedback.update).not.toHaveBeenCalled();
  });
});
