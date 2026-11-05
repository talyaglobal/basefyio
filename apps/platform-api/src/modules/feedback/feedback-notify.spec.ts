import { FeedbackStatus } from '@prisma/client';
import { AUTO_CLOSE_AFTER_MS, describeChange, mergeChange, pickAutoClose, shouldNotifyReporter } from './feedback-notify';

describe('who is notified', () => {
  it('never notifies the reporter about their own action, or an anonymous one', () => {
    expect(shouldNotifyReporter('u1', 'u1')).toBe(false);
    expect(shouldNotifyReporter('u1', undefined)).toBe(false);
    expect(shouldNotifyReporter('u1', 'root')).toBe(true);
  });

  it('folds a comment plus a status change into one notice', () => {
    const merged = mergeChange(
      { actorName: 'Ops', comments: ['Fixed in 3.0.7'] },
      { actorName: 'Ops', status: { from: 'OPEN', to: 'DONE' } },
    );
    expect(merged.comments).toEqual(['Fixed in 3.0.7']);
    expect(merged.status).toEqual({ from: 'OPEN', to: 'DONE' });
    expect(describeChange(merged)).toHaveLength(2);
  });

  it('keeps the first from and the latest to; a round trip says nothing about status', () => {
    const m = mergeChange(
      { actorName: 'Ops', status: { from: 'DONE', to: 'OPEN' } },
      { actorName: 'Ops', status: { from: 'OPEN', to: 'DONE' } },
    );
    expect(describeChange(m)).toEqual([]);
  });
});

describe('auto-close selection', () => {
  const now = new Date('2026-11-10T12:00:00Z');
  const ago = (ms: number) => new Date(now.getTime() - ms);
  it('closes after 3 days with notice, legacy silently, and leaves the rest', () => {
    const r = pickAutoClose(
      [
        { id: 'old', status: FeedbackStatus.DONE, doneAt: ago(AUTO_CLOSE_AFTER_MS) },
        { id: 'fresh', status: FeedbackStatus.DONE, doneAt: ago(AUTO_CLOSE_AFTER_MS - 1) },
        { id: 'legacy', status: FeedbackStatus.DONE, doneAt: null },
        { id: 'open', status: FeedbackStatus.OPEN, doneAt: ago(AUTO_CLOSE_AFTER_MS * 2) },
      ],
      now,
    );
    expect(r).toEqual({ notify: ['old'], silent: ['legacy'] });
  });
});
