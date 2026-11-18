jest.mock('../projects/project-database.service', () => ({ ProjectDatabaseService: class {} }));
jest.mock('../projects/project-provisioning.service', () => ({ ProjectProvisioningService: class {} }));
jest.mock('../projects/project-activity.service', () => ({
  ProjectActivityService: class {},
  ProjectActivityKind: {},
}));
jest.mock('../teams/teams.service', () => ({ TeamsService: class {} }));
jest.mock('../observability/observability.service', () => ({ ObservabilityService: class {} }));
jest.mock('../../prisma/prisma.service', () => ({ PrismaService: class {} }));

import 'reflect-metadata';
import { Controller, ForbiddenException, Get, UnauthorizedException, UseGuards } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { JwtOrApiKeyGuard } from '../../common/guards/jwt-or-apikey.guard';
import { confineToTokenTeam, tokenContext } from '../../common/request-context/token-context';
import { ProjectDatabaseController } from '../projects/project-database.controller';
import { TeamsController } from '../teams/teams.controller';
import { ApiTokensService } from './api-tokens.service';
import { JwtOrPlatformTokenGuard } from './jwt-or-platform-token.guard';
import { ScopesGuard } from './scopes.guard';
import { ALL_SCOPES } from './api-tokens.constants';

/** A controller that forgot @Scopes: the token must be refused, not given its owner's power. */
@Controller('projects/:projectId/forgotten')
@UseGuards(JwtOrPlatformTokenGuard, ScopesGuard)
class ForgottenScopesController {
  @Get()
  list() {
    return [];
  }
}

const PROJECTS: Record<string, string> = { 'p-team1': 'team1', 'p-team2': 'team2' };

function makeTokens(token: { teamId: string | null; scopes: string[] }) {
  const prisma = {
    platformApiToken: {
      findUnique: jest.fn().mockResolvedValue({
        id: 'tok1',
        userId: 'owner',
        teamId: token.teamId,
        scopes: token.scopes,
        status: 'active',
        expiresAt: null,
        lastUsedAt: new Date(),
      }),
      update: jest.fn().mockResolvedValue({}),
    },
    project: {
      findMany: jest.fn().mockImplementation(({ where }) =>
        (where.id.in as string[]).filter((id) => PROJECTS[id]).map((id) => ({ id, teamId: PROJECTS[id] })),
      ),
    },
    user: { findUnique: jest.fn().mockResolvedValue({ email: 'owner@example.com' }) },
  } as any;
  return new ApiTokensService(prisma);
}

function ctx(
  cls: any,
  handler: string,
  req: { headers?: Record<string, string>; params?: Record<string, string>; query?: any; body?: any },
) {
  const request: any = { headers: {}, params: {}, query: {}, body: {}, ...req };
  return {
    request,
    context: {
      getHandler: () => cls.prototype[handler],
      getClass: () => cls,
      switchToHttp: () => ({ getRequest: () => request }),
    } as any,
  };
}

const BEARER = { authorization: 'Bearer bf_pat_test' };

/** Runs the token guard then ScopesGuard inside a request context, as the app does. */
async function run(
  token: { teamId: string | null; scopes: string[] },
  cls: any,
  handler: string,
  req: { params?: Record<string, string>; query?: any; body?: any } = {},
) {
  const guard = new JwtOrPlatformTokenGuard(makeTokens(token), new Reflector());
  const { request, context } = ctx(cls, handler, { headers: BEARER, ...req });
  return tokenContext.run({}, async () => {
    await guard.canActivate(context);
    new ScopesGuard(new Reflector()).canActivate(context);
    return { request, store: tokenContext.getStore() };
  });
}

describe('platform API token enforcement', () => {
  const allScopes = [...ALL_SCOPES];

  it('(a) a token holding the scope passes and acts as its owner', async () => {
    const { request, store } = await run({ teamId: null, scopes: ['schema:read'] }, ProjectDatabaseController, 'listIndexes', {
      params: { projectId: 'p-team1' },
    });
    expect(request.user).toEqual({ sub: 'owner', email: 'owner@example.com', roles: [] });
    expect(request.platformToken).toMatchObject({ id: 'tok1', teamId: null, scopes: ['schema:read'] });
    expect(store?.token).toEqual({ id: 'tok1', userId: 'owner', teamId: null });
  });

  it('(b) a token without the scope gets 403 (read scope on a write route)', async () => {
    await expect(
      run({ teamId: null, scopes: ['schema:read'] }, ProjectDatabaseController, 'createIndex', {
        params: { projectId: 'p-team1' },
      }),
    ).rejects.toThrow(new ForbiddenException('API token is missing required scope(s): schema:write'));
  });

  it('(c) a token on a dashboard-session route gets 403, with any scope', async () => {
    const { context } = ctx(TeamsController, 'findAll', { headers: BEARER });
    expect(() => new JwtAuthGuard().canActivate(context)).toThrow(ForbiddenException);
    // A @JwtOnly() handler on a token-enabled controller refuses even a token holding every scope.
    await expect(
      run({ teamId: null, scopes: allScopes }, TeamsController, 'transferOwnership', { params: { id: 'team1' } }),
    ).rejects.toThrow(ForbiddenException);
  });

  it('(c) a token on a session-or-project-key route gets 403, not a silent fallback', async () => {
    const jwt = new JwtAuthGuard();
    const guard = new JwtOrApiKeyGuard(jwt, { canActivate: jest.fn() } as any);
    const { context } = ctx(TeamsController, 'findAll', { headers: BEARER });
    await expect(guard.canActivate(context)).rejects.toThrow(ForbiddenException);
  });

  it('(d) a token on a handler that declares no @Scopes gets 403 (fail closed)', async () => {
    await expect(
      run({ teamId: null, scopes: allScopes }, ForgottenScopesController, 'list', { params: { projectId: 'p-team1' } }),
    ).rejects.toThrow(ForbiddenException);
    // ScopesGuard alone fails closed too, for a controller that skips the token guard's own check.
    const { context, request } = ctx(ForgottenScopesController, 'list', {});
    request.platformToken = { scopes: allScopes };
    expect(() => new ScopesGuard(new Reflector()).canActivate(context)).toThrow(ForbiddenException);
  });

  describe('(e) a team-restricted token stays in its team', () => {
    const team1 = { teamId: 'team1', scopes: allScopes };

    it('reaches a project of its own team', async () => {
      await expect(
        run(team1, ProjectDatabaseController, 'listIndexes', { params: { projectId: 'p-team1' } }),
      ).resolves.toBeDefined();
    });

    it('is refused on a project of another team the owner belongs to', async () => {
      await expect(
        run(team1, ProjectDatabaseController, 'listIndexes', { params: { projectId: 'p-team2' } }),
      ).rejects.toThrow(new ForbiddenException('This API token is limited to another team.'));
    });

    it('is refused on another team by route id, query or body', async () => {
      await expect(run(team1, TeamsController, 'listMembers', { params: { id: 'team2' } })).rejects.toThrow(
        ForbiddenException,
      );
      await expect(run(team1, TeamsController, 'listMembers', { params: { id: 'team1' } })).resolves.toBeDefined();
      await expect(
        run(team1, ProjectDatabaseController, 'listIndexes', { params: { projectId: 'p-team1' }, query: { teamId: 'team2' } }),
      ).rejects.toThrow(ForbiddenException);
      await expect(
        run(team1, ProjectDatabaseController, 'createIndex', { params: { projectId: 'p-team1' }, body: { projectId: 'p-team2' } }),
      ).rejects.toThrow(ForbiddenException);
    });

    it('records the confinement for the Prisma layer', async () => {
      const { store } = await run(team1, ProjectDatabaseController, 'listIndexes', { params: { projectId: 'p-team1' } });
      expect(store?.token).toEqual({ id: 'tok1', userId: 'owner', teamId: 'team1' });
    });

    it('is refused outright when no request context is open', async () => {
      const guard = new JwtOrPlatformTokenGuard(makeTokens(team1), new Reflector());
      const { context } = ctx(ProjectDatabaseController, 'listIndexes', { headers: BEARER, params: { projectId: 'p-team1' } });
      await expect(guard.canActivate(context)).rejects.toThrow(ForbiddenException);
    });
  });

  describe('(e) Prisma confinement of owner-membership lookups', () => {
    const next = jest.fn(async (p: any) => p.args);
    const asToken = <T>(teamId: string | null, fn: () => Promise<T>) =>
      tokenContext.run({ token: { id: 't', userId: 'owner', teamId } }, fn);

    beforeEach(() => next.mockClear());

    it('narrows a membership check for another team so it finds nothing', async () => {
      const args = await asToken('team1', () =>
        confineToTokenTeam(
          { model: 'TeamMember', action: 'findUnique', args: { where: { teamId_userId: { teamId: 'team2', userId: 'owner' } } } },
          next,
        ),
      );
      expect(args.where).toEqual({ teamId_userId: { teamId: 'team2', userId: 'owner' }, AND: [{ teamId: 'team1' }] });
    });

    it('narrows user-wide project and team lists to the token team', async () => {
      const projects = await asToken('team1', () =>
        confineToTokenTeam(
          { model: 'Project', action: 'findMany', args: { where: { team: { members: { some: { userId: 'owner' } } } } } },
          next,
        ),
      );
      expect(projects.where.AND).toEqual([{ teamId: 'team1' }]);
      const teams = await asToken('team1', () =>
        confineToTokenTeam(
          { model: 'Team', action: 'findMany', args: { where: { members: { some: { userId: 'owner' } } } } },
          next,
        ),
      );
      expect(teams.where.AND).toEqual([{ id: 'team1' }]);
    });

    it('leaves queries alone that do not name the owner, unrestricted tokens and sessions', async () => {
      const bySlug = { model: 'Project', action: 'findFirst', args: { where: { slug: 'x' } } };
      expect(await asToken('team1', () => confineToTokenTeam(bySlug, next))).toEqual(bySlug.args);
      const member = { model: 'TeamMember', action: 'findMany', args: { where: { userId: 'owner' } } };
      expect(await asToken(null, () => confineToTokenTeam(member, next))).toEqual(member.args);
      expect(await confineToTokenTeam(member, next)).toEqual(member.args);
    });
  });

  describe('(f) a dashboard session is unaffected', () => {
    const sessionOk = jest.spyOn(JwtAuthGuard.prototype, 'canActivate');

    afterAll(() => sessionOk.mockRestore());

    it('goes through the Keycloak strategy and is not scope-checked', async () => {
      sessionOk.mockImplementation(function (this: any, context: any) {
        context.switchToHttp().getRequest().user = { sub: 'owner', roles: [] };
        return true as any;
      });
      const tokens = makeTokens({ teamId: null, scopes: [] });
      const verify = jest.spyOn(tokens, 'verify');
      const guard = new JwtOrPlatformTokenGuard(tokens, new Reflector());
      for (const [cls, handler] of [
        [ProjectDatabaseController, 'createIndex'],
        [TeamsController, 'transferOwnership'],
        [ForgottenScopesController, 'list'],
      ] as const) {
        const { context, request } = ctx(cls, handler, { headers: { authorization: 'Bearer eyJhbGciOi.jwt.sig' } });
        await expect(guard.canActivate(context)).resolves.toBe(true);
        expect(new ScopesGuard(new Reflector()).canActivate(context)).toBe(true);
        expect(request.platformToken).toBeUndefined();
      }
      expect(verify).not.toHaveBeenCalled();
    });

    it('an invalid token is still 401', async () => {
      const tokens = makeTokens({ teamId: null, scopes: [] });
      jest.spyOn(tokens, 'verify').mockRejectedValue(new Error('invalid token'));
      const guard = new JwtOrPlatformTokenGuard(tokens, new Reflector());
      const { context } = ctx(ProjectDatabaseController, 'listIndexes', { headers: BEARER });
      await expect(guard.canActivate(context)).rejects.toThrow(UnauthorizedException);
    });
  });
});
