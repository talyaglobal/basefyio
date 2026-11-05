import {
  ForbiddenException,
  HttpException,
  HttpStatus,
  Injectable,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import { randomUUID } from 'crypto';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { PrismaService } from '../../prisma/prisma.service';
import { RedisService } from '../redis/redis.service';
import { COUNT_HIT } from '../../common/guards/rate-limit.guard';
import { ApiTokensService, VerifiedToken } from '../api-tokens/api-tokens.service';
import { isPlatformToken } from '../api-tokens/platform-token.util';
import { TeamsService } from '../teams/teams.service';
import { ProjectsService } from '../projects/projects.service';
import { ProjectDataService } from '../projects/project-data.service';
import { ProjectActivityService } from '../projects/project-activity.service';
import { SqlService } from '../sql/sql.service';
import { StorageService } from '../storage/storage.service';
import { KeycloakAdminService } from '../auth/keycloak-admin.service';
import { McpDeps, McpToolDefinition, MCP_TOOL_SCOPES, toolsForScopes } from './mcp-tools';

const PLATFORM_VERSION: string = require('../../../package.json').version;

/** Requests per token per minute, on top of the global per-IP limit. */
export const MCP_RATE_LIMIT = 120;
/** Longest tool answer, in characters; a longer one is cut and says so. */
export const MCP_MAX_RESULT_CHARS = 100_000;

@Injectable()
export class McpService {
  private readonly logger = new Logger(McpService.name);
  private readonly deps: McpDeps;

  constructor(
    private readonly prisma: PrismaService,
    private readonly tokens: ApiTokensService,
    private readonly redis: RedisService,
    teams: TeamsService,
    projects: ProjectsService,
    data: ProjectDataService,
    sql: SqlService,
    storage: StorageService,
    keycloak: KeycloakAdminService,
    activity: ProjectActivityService,
  ) {
    this.deps = { teams, projects, data, sql, storage, keycloak, activity };
  }

  /**
   * The platform token in an Authorization header, verified now: a revoked or
   * expired token fails on its next request. Dashboard sessions are refused;
   * the MCP server speaks to tokens only, so every call is bounded by scopes.
   */
  async authenticate(header: string | undefined): Promise<VerifiedToken> {
    const bearer = typeof header === 'string' && /^bearer /i.test(header) ? header.slice(7).trim() : '';
    if (!isPlatformToken(bearer)) {
      throw new UnauthorizedException('Send a basefyio API token: Authorization: Bearer bf_pat_...');
    }
    let token: VerifiedToken;
    try {
      token = await this.tokens.verify(bearer);
    } catch {
      throw new UnauthorizedException('Invalid, revoked or expired API token');
    }
    if (!token.userId) throw new UnauthorizedException('Invalid API token');
    if (!token.scopes.some((s) => MCP_TOOL_SCOPES.includes(s))) {
      throw new ForbiddenException(
        `This token holds no scope that unlocks an MCP tool. Add one of: ${MCP_TOOL_SCOPES.join(', ')}.`,
      );
    }
    return token;
  }

  /** Per-token request budget. Redis being down does not take the server down. */
  async rateLimit(tokenId: string): Promise<void> {
    let count = 0;
    try {
      count = Number(await this.redis.getClient().eval(COUNT_HIT, 1, `rl:mcp:${tokenId}`, '60'));
    } catch (err: any) {
      this.logger.warn(`MCP rate limit unavailable: ${err?.message ?? err}`);
    }
    if (count > MCP_RATE_LIMIT) {
      throw new HttpException(
        `Too many MCP requests for this token (limit ${MCP_RATE_LIMIT} per minute). Try again shortly.`,
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
  }

  /** A server for one request, holding only the tools this token's scopes allow. */
  buildServer(token: VerifiedToken): McpServer {
    const server = new McpServer({ name: 'basefyio', version: PLATFORM_VERSION });
    for (const tool of toolsForScopes(token.scopes)) {
      server.registerTool(
        tool.name,
        { title: tool.title, description: tool.description, inputSchema: tool.input as any, annotations: tool.annotations },
        ((args: Record<string, unknown>) => this.invoke(tool, args ?? {}, token)) as any,
      );
    }
    return server;
  }

  /** One tool call: scope, tenancy, run, bounded answer, audit row. */
  async invoke(tool: McpToolDefinition, args: Record<string, any>, token: VerifiedToken): Promise<CallToolResult> {
    const projectId = typeof args.projectId === 'string' ? args.projectId : null;
    let outcome: 'ok' | 'denied' | 'error' = 'ok';
    let status = 200;
    try {
      // Registration already filtered by scope; this is the check on the call itself.
      if (!token.scopes.includes(tool.scope)) {
        throw new ForbiddenException(`This token lacks the ${tool.scope} scope that ${tool.name} needs.`);
      }
      if (args.teamId !== undefined) await this.assertTeam(token, String(args.teamId));
      if (args.projectId !== undefined) await this.assertProject(token, String(args.projectId));
      const result = await tool.run(args, {
        userId: token.userId,
        teamId: token.teamId,
        tokenId: token.id,
        deps: this.deps,
      });
      return { content: [{ type: 'text', text: bounded(result) }] };
    } catch (err: any) {
      status = err instanceof HttpException ? err.getStatus() : 500;
      outcome = status === 401 || status === 403 || status === 404 ? 'denied' : 'error';
      return { isError: true, content: [{ type: 'text', text: this.errorText(err) }] };
    } finally {
      // Who, which tool, which project, how it went: never the arguments.
      this.prisma.auditLog
        .create({
          data: {
            traceId: randomUUID(),
            actorUserId: token.userId,
            actorRole: 'API_TOKEN',
            action: `mcp.${tool.name}`,
            resourceType: 'mcp',
            resourceId: projectId,
            severity: outcome === 'ok' ? 'LOW' : 'MEDIUM',
            success: outcome === 'ok',
            metadataJson: { tokenId: token.id, tool: tool.name, scope: tool.scope, projectId, outcome, status },
          },
        })
        .catch((e: any) => this.logger.warn(`MCP audit row not written: ${e?.message ?? e}`));
    }
  }

  /** The token's team restriction first, then membership — on every call. */
  private async assertTeam(token: VerifiedToken, teamId: string): Promise<void> {
    if (token.teamId && token.teamId !== teamId) {
      throw new ForbiddenException('This token is restricted to another team.');
    }
    if (!(await this.isMember(teamId, token.userId))) {
      throw new ForbiddenException('You are not a member of that team.');
    }
  }

  private async assertProject(token: VerifiedToken, projectId: string): Promise<void> {
    const project = await this.prisma.project.findFirst({
      where: { id: projectId, status: { not: 'DELETED' } },
      select: { teamId: true },
    });
    // One answer for "no such project", "another team's" and "outside this
    // token's team", so a token cannot probe which project ids exist.
    const allowed =
      !!project &&
      (!token.teamId || project.teamId === token.teamId) &&
      (await this.isMember(project.teamId, token.userId));
    if (!allowed) throw new ForbiddenException('Project not found, or this token cannot reach it.');
  }

  private async isMember(teamId: string, userId: string): Promise<boolean> {
    if (!teamId || !userId) return false;
    const m = await this.prisma.teamMember.findUnique({
      where: { teamId_userId: { teamId, userId } },
      select: { id: true },
    });
    return !!m;
  }

  /**
   * HTTP errors and database errors are the caller's own business and say
   * what went wrong; anything else may carry internals, so it is logged and
   * answered generically.
   */
  private errorText(err: any): string {
    if (err instanceof HttpException) {
      const body: any = err.getResponse();
      const msg = typeof body === 'string' ? body : body?.message ?? err.message;
      return Array.isArray(msg) ? msg.join('; ') : String(msg);
    }
    if (typeof err?.code === 'string' && /^[0-9A-Z]{5}$/.test(err.code)) return `Database error: ${err.message}`;
    this.logger.error(`MCP tool failed: ${err?.stack ?? err}`);
    return 'Internal error. The call was not completed.';
  }
}

/** JSON text of a tool answer, BigInt-safe, cut at MCP_MAX_RESULT_CHARS. */
export function bounded(result: unknown): string {
  const text = JSON.stringify(result ?? null, (_k, v) => (typeof v === 'bigint' ? v.toString() : v)) ?? 'null';
  if (text.length <= MCP_MAX_RESULT_CHARS) return text;
  return `${text.slice(0, MCP_MAX_RESULT_CHARS)}\n… [cut: the answer was ${text.length} characters; ask for fewer rows or a smaller page]`;
}
