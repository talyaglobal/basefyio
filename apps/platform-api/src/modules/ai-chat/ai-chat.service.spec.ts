import { NotFoundException } from '@nestjs/common';
import { AiChatService } from './ai-chat.service';

/**
 * Chat history is per person, and that has to be enforced where the data is,
 * not where the request arrives. These cover the one question that matters:
 * can a signed-in user reach a conversation that is not theirs?
 *
 * The assertions are mostly about the WHERE clause rather than the result,
 * because the bug this prevents is a query that finds a row by id and only
 * then compares the owner — which already leaked the row, and leaks whether
 * the id exists even when it refuses.
 */
describe('AiChatService — a session belongs to one person', () => {
  const ME = 'user-me';
  const THEM = 'user-them';
  const TEAM = 'team-1';

  function harness() {
    const calls: Array<{ op: string; args: any }> = [];
    const record = (op: string) => (args: any) => {
      calls.push({ op, args });
      if (op === 'session.findMany') return Promise.resolve([]);
      if (op === 'session.findFirst') {
        const w = args?.where ?? {};
        // Stand in for the database: a row exists only for its owner.
        return Promise.resolve(w.userId === ME ? { id: w.id, title: null } : null);
      }
      if (op === 'session.deleteMany') {
        return Promise.resolve({ count: args?.where?.userId === ME ? 1 : 0 });
      }
      if (op === 'session.create') return Promise.resolve({ id: 'new', title: null });
      if (op === 'message.count') return Promise.resolve(0);
      return Promise.resolve({ count: 0 });
    };

    const tx = {
      aiChatSession: { findFirst: record('session.findFirst'), update: record('session.update') },
      aiChatMessage: {
        createMany: record('message.createMany'),
        count: record('message.count'),
        findMany: record('message.findMany'),
        deleteMany: record('message.deleteMany'),
      },
    };

    const prisma: any = {
      aiChatSession: {
        findMany: record('session.findMany'),
        findFirst: record('session.findFirst'),
        create: record('session.create'),
        deleteMany: record('session.deleteMany'),
      },
      aiChatMessage: { deleteMany: record('message.deleteMany') },
      $transaction: (fn: any) => fn(tx),
    };
    return { svc: new AiChatService(prisma), calls };
  }

  describe('reading', () => {
    it('filters the list by the caller, never by team alone', async () => {
      const { svc, calls } = harness();
      await svc.listSessions(ME, TEAM);
      const where = calls.find((c) => c.op === 'session.findMany')!.args.where;
      expect(where).toMatchObject({ userId: ME, teamId: TEAM });
    });

    it('fetches one session by id AND owner together', async () => {
      const { svc, calls } = harness();
      await svc.getSession(ME, 'session-1');
      const where = calls.find((c) => c.op === 'session.findFirst')!.args.where;
      expect(where).toMatchObject({ id: 'session-1', userId: ME });
    });

    it("refuses another person's session", async () => {
      const { svc } = harness();
      await expect(svc.getSession(THEM, 'session-1')).rejects.toBeInstanceOf(NotFoundException);
    });

    /**
     * "Not found" rather than "forbidden": the second confirms the id belongs
     * to someone, which is the thing we are trying not to say.
     */
    it("reports another person's session as missing, not as forbidden", async () => {
      const { svc } = harness();
      await expect(svc.getSession(THEM, 'session-1')).rejects.toThrow(/not found/i);
    });
  });

  describe('writing', () => {
    it("will not append to another person's session", async () => {
      const { svc, calls } = harness();
      await expect(
        svc.appendMessages(THEM, 'session-1', [{ role: 'user', content: 'hello' }]),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(calls.some((c) => c.op === 'message.createMany')).toBe(false);
    });

    it('appends for the owner and stamps the session', async () => {
      const { svc, calls } = harness();
      const res = await svc.appendMessages(ME, 'session-1', [
        { role: 'user', content: 'hello' },
        { role: 'assistant', content: 'hi' },
      ]);
      expect(res).toEqual({ appended: 2 });
      expect(calls.some((c) => c.op === 'message.createMany')).toBe(true);
      expect(calls.some((c) => c.op === 'session.update')).toBe(true);
    });

    it('checks ownership inside the same transaction as the write', async () => {
      const { svc, calls } = harness();
      await svc.appendMessages(ME, 'session-1', [{ role: 'user', content: 'x' }]);
      const check = calls.findIndex((c) => c.op === 'session.findFirst');
      const write = calls.findIndex((c) => c.op === 'message.createMany');
      expect(check).toBeGreaterThanOrEqual(0);
      expect(write).toBeGreaterThan(check);
    });

    it('drops empty turns rather than storing them', async () => {
      const { svc } = harness();
      expect(await svc.appendMessages(ME, 's', [{ role: 'user', content: '' }])).toEqual({
        appended: 0,
      });
    });

    it('names the session after the first thing the person said', async () => {
      const { svc, calls } = harness();
      await svc.appendMessages(ME, 'session-1', [{ role: 'user', content: 'how do I add a table' }]);
      const update = calls.find((c) => c.op === 'session.update')!;
      expect(update.args.data.title).toBe('how do I add a table');
    });
  });

  describe('deleting', () => {
    it('deletes by id and owner together', async () => {
      const { svc, calls } = harness();
      await svc.deleteSession(ME, 'session-1');
      const where = calls.find((c) => c.op === 'session.deleteMany')!.args.where;
      expect(where).toMatchObject({ id: 'session-1', userId: ME });
    });

    it("cannot delete another person's session", async () => {
      const { svc } = harness();
      await expect(svc.deleteSession(THEM, 'session-1')).rejects.toBeInstanceOf(NotFoundException);
    });

    it('clears only the caller’s own history', async () => {
      const { svc, calls } = harness();
      await svc.clearAll(ME, TEAM);
      const where = calls.find((c) => c.op === 'session.deleteMany')!.args.where;
      expect(where).toMatchObject({ userId: ME, teamId: TEAM });
    });
  });

  /**
   * Every call that touches a session must carry the user id. If a method is
   * added later that forgets, this fails rather than shipping.
   */
  it('never queries a session without a user id in the clause', async () => {
    const { svc, calls } = harness();
    await svc.listSessions(ME, TEAM);
    await svc.getSession(ME, 's');
    await svc.deleteSession(ME, 's');
    await svc.clearAll(ME, TEAM);
    const sessionQueries = calls.filter((c) => c.op.startsWith('session.') && c.op !== 'session.create' && c.op !== 'session.update');
    expect(sessionQueries.length).toBeGreaterThan(0);
    for (const q of sessionQueries) {
      expect(q.args.where.userId).toBe(ME);
    }
  });
});
