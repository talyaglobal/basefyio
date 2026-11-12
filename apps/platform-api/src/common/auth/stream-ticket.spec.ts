import { ExecutionContext, UnauthorizedException } from '@nestjs/common';
import {
  STREAM_TICKET_TTL_MS,
  isStreamPath,
  issueStreamTicket,
  redeemStreamTicket,
  resetStreamTicketKeyForTests,
} from './stream-ticket';
import { JwtAuthGuard } from '../guards/jwt-auth.guard';

const user = { sub: 'u1', email: 'a@b.c', preferred_username: 'a@b.c', roles: ['offline_access'] };
const PATH = '/api/realtime/stream';

beforeEach(() => {
  process.env.STREAM_TICKET_SECRET = 'test-secret';
  resetStreamTicketKeyForTests();
});

describe('stream tickets', () => {
  it('only event-stream routes take tickets', () => {
    expect(isStreamPath('/api/realtime/stream')).toBe(true);
    expect(isStreamPath('/api/projects/p1/export/jobs/j1/events')).toBe(true);
    expect(isStreamPath('/api/projects/import-supabase/jobs/j1/events')).toBe(true);
    expect(isStreamPath('/api/projects/p1')).toBe(false);
    expect(isStreamPath('/api/account/api-tokens')).toBe(false);
  });

  it('is accepted once, for its own path, before it expires', () => {
    const { ticket, expiresIn } = issueStreamTicket(user, PATH);
    expect(expiresIn).toBe(STREAM_TICKET_TTL_MS / 1000);
    expect(redeemStreamTicket(ticket, '/api/projects/p1/export/jobs/j1/events')).toBeNull();
    expect(redeemStreamTicket(ticket, PATH)).toMatchObject({ sub: 'u1', email: 'a@b.c' });
    expect(redeemStreamTicket(ticket, PATH)).toBeNull(); // single use
  });

  it('rejects an expired or forged ticket', () => {
    const now = Date.now();
    const old = issueStreamTicket(user, PATH, now - STREAM_TICKET_TTL_MS - 1);
    expect(redeemStreamTicket(old.ticket, PATH)).toBeNull();
    const { ticket } = issueStreamTicket(user, PATH);
    const [body] = ticket.split('.');
    const forgedBody = Buffer.from(
      JSON.stringify({ ...JSON.parse(Buffer.from(body, 'base64url').toString()), u: 'someone-else' }),
    ).toString('base64url');
    expect(redeemStreamTicket(`${forgedBody}.${ticket.split('.')[1]}`, PATH)).toBeNull();
    expect(redeemStreamTicket('garbage', PATH)).toBeNull();
  });

  it('a ticket signed with another key is refused', () => {
    const { ticket } = issueStreamTicket(user, PATH);
    process.env.STREAM_TICKET_SECRET = 'other-secret';
    resetStreamTicketKeyForTests();
    expect(redeemStreamTicket(ticket, PATH)).toBeNull();
  });
});

describe('JwtAuthGuard with a stream ticket', () => {
  function ctx(req: any): ExecutionContext {
    return { getType: () => 'http', switchToHttp: () => ({ getRequest: () => req }) } as any;
  }

  it('authenticates an event-stream GET from its ticket', () => {
    const { ticket } = issueStreamTicket(user, PATH);
    const req: any = { method: 'GET', path: PATH, query: { ticket }, headers: {} };
    expect(new JwtAuthGuard().canActivate(ctx(req))).toBe(true);
    expect(req.user.sub).toBe('u1');
  });

  it('refuses a spent ticket with 401', () => {
    const { ticket } = issueStreamTicket(user, PATH);
    redeemStreamTicket(ticket, PATH);
    const req: any = { method: 'GET', path: PATH, query: { ticket }, headers: {} };
    expect(() => new JwtAuthGuard().canActivate(ctx(req))).toThrow(UnauthorizedException);
  });

  it('never lets a ticket open a non-stream route', () => {
    const { ticket } = issueStreamTicket(user, '/api/projects/p1/export/jobs/j1/events');
    const req: any = { method: 'GET', path: '/api/projects/p1', query: { ticket }, headers: {} };
    // Falls through to the JWT strategy, which has no token here.
    const guard = new JwtAuthGuard();
    const superSpy = jest
      .spyOn(Object.getPrototypeOf(JwtAuthGuard.prototype), 'canActivate')
      .mockReturnValue(false as any);
    expect(guard.canActivate(ctx(req))).toBe(false);
    expect(req.user).toBeUndefined();
    superSpy.mockRestore();
  });
});
