jest.mock('../../prisma/prisma.service', () => ({ PrismaService: class {} }));

/**
 * The token context must survive the real Nest pipeline: middleware opens it, the guard fills it,
 * and a service call made by the handler sees it (that is where the Prisma confinement runs).
 */
import 'reflect-metadata';
import { Controller, Get, MiddlewareConsumer, Module, NestModule, Param, UseGuards } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import {
  TokenContextMiddleware,
  confineToTokenTeam,
  currentTokenConfinement,
} from '../../common/request-context/token-context';
import { ApiTokensService } from './api-tokens.service';
import { JwtOrPlatformTokenGuard } from './jwt-or-platform-token.guard';
import { ScopesGuard } from './scopes.guard';
import { Scopes } from './scopes.decorator';

/** What a service's membership check would send to Prisma, after the confinement middleware. */
async function membershipLookup(teamId: string, userId: string) {
  return confineToTokenTeam(
    { model: 'TeamMember', action: 'findUnique', args: { where: { teamId_userId: { teamId, userId } } } },
    async (p) => p.args.where,
  );
}

@Controller('projects/:projectId/probe')
@UseGuards(JwtOrPlatformTokenGuard, ScopesGuard)
class ProbeController {
  @Get()
  @Scopes('projects:read')
  async probe(@Param('projectId') _projectId: string) {
    await new Promise((r) => setTimeout(r, 5)); // across an async boundary, like a real service
    return { confinement: currentTokenConfinement() ?? null, where: await membershipLookup('team2', 'owner') };
  }
}

const tokens = {
  verify: jest.fn(),
  assertWithinTeam: jest.fn().mockResolvedValue(undefined),
  ownerEmail: jest.fn().mockResolvedValue('owner@example.com'),
};

@Module({
  controllers: [ProbeController],
  providers: [{ provide: ApiTokensService, useValue: tokens }],
})
class ProbeModule implements NestModule {
  configure(consumer: MiddlewareConsumer) {
    consumer.apply(TokenContextMiddleware).forRoutes('*');
  }
}

describe('platform token context through the Nest pipeline', () => {
  let app: any;

  beforeAll(async () => {
    const mod = await Test.createTestingModule({ imports: [ProbeModule] }).compile();
    app = mod.createNestApplication();
    await app.init();
  });

  afterAll(async () => app?.close());

  it('confines the handler’s membership lookups to the token team', async () => {
    tokens.verify.mockResolvedValue({ id: 't1', userId: 'owner', teamId: 'team1', scopes: ['projects:read'] });
    const res = await request(app.getHttpServer())
      .get('/projects/p1/probe')
      .set('Authorization', 'Bearer bf_pat_x')
      .expect(200);
    expect(res.body.confinement).toEqual({ userId: 'owner', teamId: 'team1' });
    expect(res.body.where).toEqual({ teamId_userId: { teamId: 'team2', userId: 'owner' }, AND: [{ teamId: 'team1' }] });
  });

  it('does not leak one request’s token into the next', async () => {
    tokens.verify.mockResolvedValue({ id: 't2', userId: 'owner', teamId: null, scopes: ['projects:read'] });
    const res = await request(app.getHttpServer())
      .get('/projects/p1/probe')
      .set('Authorization', 'Bearer bf_pat_y')
      .expect(200);
    expect(res.body.confinement).toBeNull();
    expect(res.body.where).toEqual({ teamId_userId: { teamId: 'team2', userId: 'owner' } });
  });

  it('answers 403 to a token without the scope', async () => {
    tokens.verify.mockResolvedValue({ id: 't3', userId: 'owner', teamId: null, scopes: ['team:read'] });
    await request(app.getHttpServer()).get('/projects/p1/probe').set('Authorization', 'Bearer bf_pat_z').expect(403);
  });
});
