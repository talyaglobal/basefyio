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

describe('feedback author', () => {
  it('stores the account email when the token carries none', async () => {
    const prisma = {
      feedback: { create: jest.fn().mockResolvedValue({ id: 'f', title: 't', type: 'GENERAL', createdAt: new Date() }) },
      feedbackEvent: { create: jest.fn() },
      user: {
        findUnique: jest.fn().mockResolvedValue({ firstName: 'A', lastName: 'B', email: 'a@b.com' }),
        findMany: jest.fn().mockResolvedValue([]),
      },
    };
    const realtime = { publish: jest.fn() };
    const email = { sendFeedbackNotification: jest.fn().mockResolvedValue(undefined) };
    const service = new FeedbackService(prisma as any, email as any, {} as any, realtime as any, {} as any);
    await service.create({ userId: 'u', email: '', url: '/x', title: 't' } as any);
    expect(prisma.feedback.create.mock.calls[0][0].data.email).toBe('a@b.com');
  });
});
