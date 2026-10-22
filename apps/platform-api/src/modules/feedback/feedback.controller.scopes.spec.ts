jest.mock('./feedback.service', () => ({ FeedbackService: class {} }));
jest.mock('../../prisma/prisma.service', () => ({ PrismaService: class {} }));

import 'reflect-metadata';
import { ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { GUARDS_METADATA } from '@nestjs/common/constants';
import { FeedbackController } from './feedback.controller';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { JwtOrPlatformTokenGuard } from '../api-tokens/jwt-or-platform-token.guard';
import { ScopesGuard } from '../api-tokens/scopes.guard';
import { SCOPES_KEY } from '../api-tokens/scopes.decorator';
import { ALL_SCOPES } from '../api-tokens/api-tokens.constants';

const proto = FeedbackController.prototype as unknown as Record<string, (...args: unknown[]) => unknown>;
const guardsOf = (name: string) => Reflect.getMetadata(GUARDS_METADATA, proto[name]) as unknown[];
const scopesOf = (name: string) => Reflect.getMetadata(SCOPES_KEY, proto[name]) as string[] | undefined;

/** The routes a triage tool may reach with a personal API token, and the scope each needs. */
const TOKEN_ROUTES: Record<string, string> = {
  findAll: 'feedback:read',
  listComments: 'feedback:read',
  listHistory: 'feedback:read',
  addComment: 'feedback:write',
  updateStatus: 'feedback:write',
};

/** Everything else stays reachable with a dashboard session only. */
const SESSION_ONLY = [
  'uploadAttachment',
  'create',
  'updateFeedback',
  'removeFeedback',
  'updateComment',
  'removeComment',
];

describe('FeedbackController token access', () => {
  it('lists both feedback scopes in the token catalogue', () => {
    expect(ALL_SCOPES.has('feedback:read')).toBe(true);
    expect(ALL_SCOPES.has('feedback:write')).toBe(true);
  });

  it.each(Object.entries(TOKEN_ROUTES))('%s accepts a token holding %s', (name, scope) => {
    expect(guardsOf(name)).toEqual([JwtOrPlatformTokenGuard, ScopesGuard]);
    expect(scopesOf(name)).toEqual([scope]);
  });

  it.each(SESSION_ONLY)('%s still requires a dashboard session', (name) => {
    expect(guardsOf(name)).toEqual([JwtAuthGuard]);
    expect(scopesOf(name)).toBeUndefined();
  });

  it('covers every route handler on the controller', () => {
    const handlers = Object.getOwnPropertyNames(FeedbackController.prototype).filter((n) => n !== 'constructor');
    expect(handlers.sort()).toEqual([...Object.keys(TOKEN_ROUTES), ...SESSION_ONLY].sort());
  });

  it('refuses a read-only token on the write routes and allows it on the read routes', () => {
    const guard = new ScopesGuard(new Reflector());
    const ctx = (name: string, scopes: string[]) =>
      ({
        getHandler: () => proto[name],
        getClass: () => FeedbackController,
        switchToHttp: () => ({ getRequest: () => ({ platformToken: { scopes } }) }),
      }) as any;

    expect(guard.canActivate(ctx('findAll', ['feedback:read']))).toBe(true);
    expect(() => guard.canActivate(ctx('updateStatus', ['feedback:read']))).toThrow(ForbiddenException);
    expect(() => guard.canActivate(ctx('addComment', ['projects:read']))).toThrow(ForbiddenException);
    expect(guard.canActivate(ctx('addComment', ['feedback:read', 'feedback:write']))).toBe(true);
  });
});
