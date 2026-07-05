// Stub the heavy product services (their import chain pulls in the ESM-only
// @keycloak/keycloak-admin-client). We inject our own mocks into CodefyioService
// anyway, so the real classes are never needed here.
jest.mock('../modules/projects/projects.service', () => ({ ProjectsService: class {} }));
jest.mock('../modules/projects/collection.service', () => ({ CollectionService: class {} }));
jest.mock('../modules/sql/sql.service', () => ({ SqlService: class {} }));

import { ForbiddenException, UnauthorizedException } from '@nestjs/common';
import * as jwt from 'jsonwebtoken';
import { CodefyioService } from './codefyio.service';
import { CodefyioJwtService } from './codefyio-jwt.service';

const CFG: Record<string, unknown> = {
  'codefyio.jwtSecret': 'test-secret',
  'codefyio.audience': 'codefyio',
  'codefyio.sessionSecret': 'sess-secret',
  'codefyio.sessionTtlSeconds': 3600,
};
const config = { get: (k: string) => CFG[k] } as any;

const signCodefyio = (secret = 'test-secret') =>
  jwt.sign({ sub: 'cf-1', email: 'user@example.com' }, secret, {
    audience: 'codefyio',
    expiresIn: 3600,
  });

function makeService() {
  const prisma = {
    user: { findUnique: jest.fn().mockResolvedValue({ id: 'u1', activeTeamId: 't1' }) },
    teamMember: { findFirst: jest.fn().mockResolvedValue({ teamId: 't1' }) },
    $queryRaw: jest.fn().mockResolvedValue([{ ok: 1 }]),
  } as any;
  const projects = {
    findAll: jest.fn().mockResolvedValue([
      { id: 'p1', name: 'Proj 1', slug: 'proj-1', status: 'ACTIVE', databaseType: 'RELATIONAL' },
    ]),
    findOne: jest.fn().mockResolvedValue({ id: 'p1', name: 'Proj 1', status: 'ACTIVE', databaseType: 'RELATIONAL' }),
  } as any;
  const collections = { listCollections: jest.fn().mockResolvedValue([{ name: 'users', documentCount: 3 }]) } as any;
  const sql = { execute: jest.fn().mockResolvedValue({ rows: [{ n: 1 }], rowCount: 1 }) } as any;
  const jwtSvc = new CodefyioJwtService(config);
  const service = new CodefyioService(prisma, jwtSvc, projects, collections, sql);
  return { service, jwtSvc, prisma, projects, collections, sql };
}

const SESSION = { userId: 'u1', teamId: 't1', email: 'user@example.com' };

describe('CodefyioService', () => {
  it('exchanges a valid Codefyio token for a working session', async () => {
    const { service, jwtSvc } = makeService();
    const r = await service.exchange(signCodefyio());
    expect(r.account).toBe('user@example.com');
    expect(r.accessToken).toBeTruthy();
    expect(jwtSvc.verifySession(r.accessToken)).toMatchObject({ userId: 'u1', teamId: 't1' });
  });

  it('rejects a tampered / forged Codefyio token', async () => {
    const { service } = makeService();
    await expect(service.exchange(signCodefyio('wrong-secret'))).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });

  it('reports ok status', async () => {
    const { service } = makeService();
    expect(await service.getStatus()).toEqual({ status: 'ok' });
  });

  it('lists projects as resources', async () => {
    const { service } = makeService();
    const r = await service.listResources(SESSION);
    expect(r.items).toHaveLength(1);
    expect(r.items[0]).toMatchObject({ id: 'p1', kind: 'project' });
  });

  it('executes a whitelisted action (sql.run) against the project', async () => {
    const { service, sql } = makeService();
    const r = await service.executeAction(SESSION, {
      action: 'sql.run',
      resourceId: 'p1',
      params: { query: 'select 1' },
    });
    expect(r.ok).toBe(true);
    expect(sql.execute).toHaveBeenCalledWith('p1', 'select 1', 'u1');
  });

  it('rejects an action not on the manifest allow-list', async () => {
    const { service } = makeService();
    await expect(
      service.executeAction(SESSION, { action: 'db.drop', resourceId: 'p1' }),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });
});
