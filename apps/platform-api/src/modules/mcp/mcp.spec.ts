// Services the tools call are doubles; loading the real modules would pull in
// the Keycloak admin client and live connections this test does not need.
jest.mock('../projects/projects.service', () => ({ ProjectsService: class {} }));
jest.mock('../projects/project-data.service', () => ({ ProjectDataService: class {} }));
jest.mock('../teams/teams.service', () => ({ TeamsService: class {} }));
jest.mock('../storage/storage.service', () => ({ StorageService: class {} }));
jest.mock('../auth/keycloak-admin.service', () => ({ KeycloakAdminService: class {} }));

import { UnauthorizedException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { McpController } from './mcp.controller';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { ApiTokensService, VerifiedToken } from '../api-tokens/api-tokens.service';
import { SqlService } from '../sql/sql.service';
import { McpService } from './mcp.service';
import { assertToolCatalogue, MCP_TOOLS, McpToolDefinition } from './mcp-tools';

const PROJECT = '11111111-1111-4111-8111-111111111111';

function token(over: Partial<VerifiedToken> = {}): VerifiedToken {
  return { id: 'tok1', userId: 'u1', teamId: null, scopes: [], ...over };
}

/** Project PROJECT lives in team-a; `members` lists [teamId, userId] pairs. */
function harness(members: [string, string][] = [['team-a', 'u1']], tokenRow: any = null) {
  const pg = {
    query: jest.fn().mockResolvedValue({ rows: [{ n: 1 }], fields: [{ name: 'n', dataTypeID: 23 }], rowCount: 1 }),
    release: jest.fn(),
  };
  const prisma: any = {
    project: {
      findFirst: jest.fn(async ({ where }: any) =>
        where.id === PROJECT
          ? { id: PROJECT, teamId: 'team-a', dbHost: 'h', dbPort: 5432, dbUser: 'u', dbPassword: 'pw', dbName: 'db' }
          : null,
      ),
    },
    teamMember: {
      findUnique: jest.fn(async ({ where: { teamId_userId: k } }: any) =>
        members.some(([t, u]) => t === k.teamId && u === k.userId) ? { id: 'm' } : null,
      ),
    },
    auditLog: { create: jest.fn().mockResolvedValue({}) },
    sqlAuditLog: { create: jest.fn().mockResolvedValue({ id: 'a1' }) },
    platformApiToken: { findUnique: jest.fn().mockResolvedValue(tokenRow), update: jest.fn().mockResolvedValue({}) },
  };
  const activity = { append: jest.fn().mockResolvedValue(undefined) };
  const sql = new SqlService(prisma, {} as any, activity as any, { enqueueJob: jest.fn() } as any, {} as any);
  (sql as any).getPool = () => ({ connect: async () => pg });
  const data = { listTables: jest.fn().mockResolvedValue([{ name: 'orders' }]) };
  const teams = {
    findAllForUser: jest.fn().mockResolvedValue([
      { id: 'team-a', name: 'A', slug: 'a', role: 'OWNER', projectCount: 1 },
      { id: 'team-b', name: 'B', slug: 'b', role: 'MEMBER', projectCount: 0 },
    ]),
  };
  const projects = { findAll: jest.fn().mockResolvedValue([{ id: PROJECT, name: 'p' }]) };
  const svc = new McpService(
    prisma,
    new ApiTokensService(prisma),
    {} as any,
    teams as any,
    projects as any,
    data as any,
    sql,
    {} as any,
    {} as any,
    activity as any,
  );
  return { svc, prisma, pg, data, projects };
}

async function connect(svc: McpService, t: VerifiedToken) {
  const [serverSide, clientSide] = InMemoryTransport.createLinkedPair();
  await svc.buildServer(t).connect(serverSide);
  const client = new Client({ name: 'spec', version: '1' });
  await client.connect(clientSide);
  return client;
}

/** A tool call's text, whether the SDK answers with an error result or a protocol error. */
async function call(client: Client, name: string, args: Record<string, unknown>) {
  try {
    const r: any = await client.callTool({ name, arguments: args });
    return { isError: !!r.isError, text: r.content?.[0]?.text ?? '' };
  } catch (e: any) {
    return { isError: true, text: String(e?.message ?? e) };
  }
}

const tool = (name: string) => MCP_TOOLS.find((t) => t.name === name) as McpToolDefinition;

describe('MCP: scopes decide what a token sees and calls', () => {
  it('lists only the tools its scopes allow', async () => {
    const { svc } = harness();
    const client = await connect(svc, token({ scopes: ['projects:read'] }));
    const names = (await client.listTools()).tools.map((t) => t.name).sort();
    expect(names).toEqual(['get_project', 'list_projects']);
  });

  it('cannot call a tool outside its scopes, through the protocol or directly', async () => {
    const { svc, pg } = harness();
    const t = token({ scopes: ['projects:read'] });
    const client = await connect(svc, t);
    const viaProtocol = await call(client, 'run_sql', { projectId: PROJECT, query: 'SELECT 1' });
    expect(viaProtocol.isError).toBe(true);
    const direct = await svc.invoke(tool('run_sql'), { projectId: PROJECT, query: 'SELECT 1' }, t);
    expect(direct.isError).toBe(true);
    expect((direct.content[0] as any).text).toMatch(/lacks the sql:run scope/);
    expect(pg.query).not.toHaveBeenCalled();
  });

  it('refuses a token that unlocks no tool at all', async () => {
    const { svc } = harness([], { id: 't', userId: 'u1', teamId: null, scopes: ['billing:read'], status: 'active', expiresAt: null, lastUsedAt: new Date() });
    await expect(svc.authenticate('Bearer bf_pat_x')).rejects.toThrow(/no scope that unlocks an MCP tool/);
  });
});

describe('MCP: tenancy is checked on every call', () => {
  it("denies a token whose owner is not on the project's team", async () => {
    const { svc, data } = harness([['team-a', 'someone-else']]);
    const r = await svc.invoke(tool('list_tables'), { projectId: PROJECT }, token({ scopes: ['schema:read'] }));
    expect(r.isError).toBe(true);
    expect((r.content[0] as any).text).toMatch(/cannot reach it/);
    expect(data.listTables).not.toHaveBeenCalled();
  });

  it('lets a member through, with the owner id handed to the service', async () => {
    const { svc, data } = harness();
    const r = await svc.invoke(tool('list_tables'), { projectId: PROJECT }, token({ scopes: ['schema:read'] }));
    expect(r.isError).toBeFalsy();
    expect(data.listTables).toHaveBeenCalledWith(PROJECT, 'u1');
  });

  it("keeps a team-restricted token out of another team's project, even when its owner is a member there", async () => {
    const { svc, data, projects } = harness([['team-a', 'u1'], ['team-b', 'u1']]);
    const t = token({ teamId: 'team-b', scopes: ['schema:read', 'projects:read', 'team:read'] });

    const tables = await svc.invoke(tool('list_tables'), { projectId: PROJECT }, t);
    expect(tables.isError).toBe(true);
    expect(data.listTables).not.toHaveBeenCalled();

    const list = await svc.invoke(tool('list_projects'), { teamId: 'team-a' }, t);
    expect(list.isError).toBe(true);
    expect((list.content[0] as any).text).toMatch(/restricted to another team/);
    expect(projects.findAll).not.toHaveBeenCalled();

    const teams = await svc.invoke(tool('list_teams'), {}, t);
    expect(JSON.parse((teams.content[0] as any).text).map((x: any) => x.id)).toEqual(['team-b']);

    // Without a teamId argument it lists only the token's own team.
    await svc.invoke(tool('list_projects'), {}, t);
    expect(projects.findAll).toHaveBeenCalledTimes(1);
    expect(projects.findAll).toHaveBeenCalledWith('team-b', 'u1');
  });

  it('writes an audit row per call with the token, tool, project and outcome, and no arguments', async () => {
    const { svc, prisma } = harness([]);
    await svc.invoke(tool('query_sql'), { projectId: PROJECT, query: "SELECT 'secret-value'" }, token({ scopes: ['sql:read'] }));
    await new Promise((r) => setImmediate(r));
    const row = prisma.auditLog.create.mock.calls[0][0].data;
    expect(row).toMatchObject({ actorUserId: 'u1', action: 'mcp.query_sql', resourceId: PROJECT, success: false });
    expect(row.metadataJson).toMatchObject({ tokenId: 'tok1', tool: 'query_sql', outcome: 'denied' });
    expect(JSON.stringify(row)).not.toContain('secret-value');
  });
});

describe('MCP: the token is verified on every request', () => {
  const row = (over: any = {}) => ({
    id: 't1', userId: 'u1', teamId: null, scopes: ['projects:read'], status: 'active', expiresAt: null, lastUsedAt: new Date(), ...over,
  });

  it('accepts an active token', async () => {
    const { svc } = harness([], row());
    await expect(svc.authenticate('Bearer bf_pat_live')).resolves.toMatchObject({ id: 't1', userId: 'u1' });
  });

  it('denies a revoked token', async () => {
    const { svc } = harness([], row({ status: 'revoked' }));
    await expect(svc.authenticate('Bearer bf_pat_revoked')).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('denies an expired token', async () => {
    const { svc } = harness([], row({ expiresAt: new Date(Date.now() - 1000) }));
    await expect(svc.authenticate('Bearer bf_pat_old')).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('denies anything that is not a platform token, a dashboard session included', async () => {
    const { svc } = harness([], row());
    await expect(svc.authenticate('Bearer eyJhbGciOiJSUzI1NiJ9.x.y')).rejects.toBeInstanceOf(UnauthorizedException);
    await expect(svc.authenticate(undefined)).rejects.toBeInstanceOf(UnauthorizedException);
  });
});

describe('MCP: a read-only SQL token cannot write', () => {
  const ro = token({ scopes: ['sql:read'] });

  it('sees query_sql and not run_sql', async () => {
    const { svc } = harness();
    const names = (await (await connect(svc, ro)).listTools()).tools.map((t) => t.name);
    expect(names).toEqual(['query_sql']);
  });

  it.each([
    'DELETE FROM orders',
    'SELECT 1; DELETE FROM orders',
    'UPDATE orders SET paid = true',
    'DROP TABLE orders',
    'COMMIT; DELETE FROM orders',
    'SET TRANSACTION READ WRITE',
  ])('refuses %s before it reaches the database', async (query) => {
    const { svc, pg } = harness();
    const client = await connect(svc, ro);
    const r = await call(client, 'query_sql', { projectId: PROJECT, query });
    expect(r.isError).toBe(true);
    expect(pg.query).not.toHaveBeenCalled();
  });

  it('runs a read in a READ ONLY transaction, one statement on the extended protocol, then rolls back', async () => {
    const { svc, pg } = harness();
    const client = await connect(svc, ro);
    // A data-modifying CTE starts with WITH; Postgres refuses its write in the read-only transaction.
    const r = await call(client, 'query_sql', {
      projectId: PROJECT,
      query: 'WITH gone AS (DELETE FROM orders RETURNING *) SELECT * FROM gone',
    });
    expect(r.isError).toBe(false);
    const sent = pg.query.mock.calls.map((c: any[]) => c[0]);
    expect(sent[0]).toBe('BEGIN READ ONLY');
    expect(sent[1]).toMatchObject({ queryMode: 'extended' });
    expect(sent[sent.length - 1]).toBe('ROLLBACK');
    expect(sent).not.toContain('COMMIT');
  });
});

describe('MCP: POST /mcp over HTTP', () => {
  const row = { id: 't1', userId: 'u1', teamId: null, scopes: ['schema:read'], status: 'active', expiresAt: null, lastUsedAt: new Date() };
  const accept = 'application/json, text/event-stream';

  async function app(tokenRow: any) {
    const { svc } = harness(undefined, tokenRow);
    (svc as any).rateLimit = jest.fn().mockResolvedValue(undefined);
    const mod = await Test.createTestingModule({
      controllers: [McpController],
      providers: [{ provide: McpService, useValue: svc }],
    }).compile();
    const nest = mod.createNestApplication();
    await nest.init();
    return nest;
  }

  it('answers tools/list with the scoped tools, statelessly', async () => {
    const nest = await app(row);
    const res = await request(nest.getHttpServer())
      .post('/mcp')
      .set('Authorization', 'Bearer bf_pat_live')
      .set('Accept', accept)
      .send({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} });
    expect(res.status).toBe(200);
    expect(res.headers['mcp-session-id']).toBeUndefined();
    expect(res.body.result.tools.map((t: any) => t.name).sort()).toEqual(['describe_table', 'list_tables']);
    await nest.close();
  });

  it('answers a revoked token with 401 and a Bearer challenge', async () => {
    const nest = await app({ ...row, status: 'revoked' });
    const res = await request(nest.getHttpServer())
      .post('/mcp')
      .set('Authorization', 'Bearer bf_pat_revoked')
      .set('Accept', accept)
      .send({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} });
    expect(res.status).toBe(401);
    expect(res.headers['www-authenticate']).toMatch(/^Bearer/);
    await nest.close();
  });

  it('refuses a JSON-RPC batch, which would dodge the per-request rate limit', async () => {
    const nest = await app(row);
    const msg = { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} };
    const res = await request(nest.getHttpServer())
      .post('/mcp')
      .set('Authorization', 'Bearer bf_pat_live')
      .set('Accept', accept)
      .send([msg, { ...msg, id: 2 }]);
    expect(res.status).toBe(400);
    await nest.close();
  });

  it('refuses GET with 405', async () => {
    const nest = await app(row);
    const res = await request(nest.getHttpServer()).get('/mcp').set('Authorization', 'Bearer bf_pat_live');
    expect(res.status).toBe(405);
    await nest.close();
  });
});

describe('MCP: the catalogue refuses a tool that could skip a check', () => {
  const base = tool('list_tables');

  it('accepts the shipped catalogue, every tool with a known scope', () => {
    expect(() => assertToolCatalogue(MCP_TOOLS)).not.toThrow();
    expect(MCP_TOOLS.every((t) => !!t.scope)).toBe(true);
  });

  it('refuses a tool with no scope', () => {
    expect(() => assertToolCatalogue([{ ...base, name: 'x', scope: undefined as any }])).toThrow(/declares no known scope/);
    expect(() => assertToolCatalogue([{ ...base, name: 'x', scope: '' }])).toThrow(/declares no known scope/);
  });

  it('refuses a tool with an unknown scope', () => {
    expect(() => assertToolCatalogue([{ ...base, name: 'x', scope: 'sql:everything' }])).toThrow(/declares no known scope/);
  });

  it('refuses a project reference the tenancy check would not read', () => {
    expect(() => assertToolCatalogue([{ ...base, name: 'x', input: { project: base.input.projectId } }])).toThrow(/bypass/);
    expect(() =>
      assertToolCatalogue([{ ...base, name: 'x', input: { projectId: base.input.projectId.optional() } }]),
    ).toThrow(/must be required/);
  });
});
