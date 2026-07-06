import {
  ForbiddenException,
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { interval, Observable, Subscriber } from 'rxjs';
import { PrismaService } from '../prisma/prisma.service';
import { ProjectsService } from '../modules/projects/projects.service';
import { CollectionService } from '../modules/projects/collection.service';
import { SqlService } from '../modules/sql/sql.service';
import { RealtimeDataService } from '../modules/realtime-data/realtime-data.service';
import { CodefyioJwtService } from './codefyio-jwt.service';
import { ALLOWED_ACTIONS } from './codefyio.constants';
import {
  ActionRequest,
  ActionResult,
  AdapterEvent,
  AdapterSessionClaims,
  Resource,
} from './codefyio.types';

const PAGE_SIZE = 50;

/**
 * Server-side implementation of the Codefyio adapter. It is a thin orchestration
 * layer over the existing product services — it adds no new business logic, only
 * maps the Codefyio contract onto ProjectsService / CollectionService / SqlService.
 */
@Injectable()
export class CodefyioService {
  private readonly logger = new Logger(CodefyioService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly jwt: CodefyioJwtService,
    private readonly projects: ProjectsService,
    private readonly collections: CollectionService,
    private readonly sql: SqlService,
    private readonly realtime: RealtimeDataService,
  ) {}

  /**
   * Trust bridge: verify the Codefyio JWT, resolve the matching basefyio account
   * (by email), and mint a short-lived adapter session — no second login.
   */
  async exchange(codefyioToken: string): Promise<{ accessToken: string; expiresIn: number; account: string }> {
    if (!this.jwt.isConfigured()) {
      throw new ServiceUnavailableException('Codefyio adapter is not configured on this instance');
    }
    const claims = await this.jwt.verifyCodefyioToken(codefyioToken);
    if (!claims.email) {
      throw new ForbiddenException('Codefyio token has no email to link an account');
    }
    const user = await this.prisma.user.findUnique({
      where: { email: claims.email },
      select: { id: true, activeTeamId: true },
    });
    if (!user) {
      throw new ForbiddenException(`No basefyio account for ${claims.email}`);
    }
    const teamId = user.activeTeamId ?? (await this.firstTeamId(user.id));
    if (!teamId) {
      throw new ForbiddenException('Account has no team');
    }
    const { accessToken, expiresIn } = this.jwt.issueSession({
      userId: user.id,
      teamId,
      email: claims.email,
    });
    return { accessToken, expiresIn, account: claims.email };
  }

  private async firstTeamId(userId: string): Promise<string | null> {
    const m = await this.prisma.teamMember.findFirst({
      where: { userId },
      select: { teamId: true },
      orderBy: { createdAt: 'asc' },
    });
    return m?.teamId ?? null;
  }

  /** Product health for the IDE status pill. */
  async getStatus(): Promise<{ status: 'ok' | 'degraded' | 'down'; detail?: string }> {
    try {
      await this.prisma.$queryRaw`SELECT 1`;
      return { status: 'ok' };
    } catch (e: any) {
      return { status: 'down', detail: e?.message?.slice(0, 200) };
    }
  }

  /** List the account's projects as marketplace resources (cursor-paginated). */
  async listResources(
    session: AdapterSessionClaims,
    cursor?: string,
  ): Promise<{ items: Resource[]; nextCursor?: string }> {
    const all = await this.projects.findAll(session.teamId, session.userId);
    const offset = this.decodeCursor(cursor);
    const page = all.slice(offset, offset + PAGE_SIZE);
    const items: Resource[] = page.map((p: any) => ({
      id: p.id,
      name: p.name,
      kind: 'project',
      meta: { slug: p.slug, status: p.status, databaseType: p.databaseType },
    }));
    const nextOffset = offset + PAGE_SIZE;
    return {
      items,
      nextCursor: nextOffset < all.length ? this.encodeCursor(nextOffset) : undefined,
    };
  }

  /** Execute a whitelisted action. Rejects anything outside the manifest list. */
  async executeAction(session: AdapterSessionClaims, req: ActionRequest): Promise<ActionResult> {
    if (!ALLOWED_ACTIONS.has(req.action)) {
      throw new ForbiddenException(`Action not allowed: ${req.action}`);
    }
    const projectId = req.resourceId;
    if (!projectId) {
      return { ok: false, error: 'resourceId (project id) is required' };
    }
    try {
      switch (req.action) {
        case 'project.status': {
          // findOne enforces that the project belongs to the session's user/team.
          const project: any = await this.projects.findOne(projectId, session.userId);
          return {
            ok: true,
            result: {
              id: project.id,
              name: project.name,
              status: project.status,
              databaseType: project.databaseType,
            },
          };
        }
        case 'project.tables': {
          const tables = await this.collections.listCollections(projectId, session.userId);
          return { ok: true, result: tables };
        }
        case 'sql.run': {
          const query = (req.params as { query?: unknown })?.query;
          if (typeof query !== 'string' || !query.trim()) {
            return { ok: false, error: 'params.query (string) is required' };
          }
          const res = await this.sql.execute(projectId, query, session.userId);
          return { ok: true, result: res };
        }
        case 'realtime.list': {
          // findOne enforces the project belongs to the session's user/team.
          await this.projects.findOne(projectId, session.userId);
          return { ok: true, result: await this.realtime.listBindings(projectId) };
        }
        case 'realtime.set': {
          await this.projects.findOne(projectId, session.userId);
          const p = (req.params ?? {}) as { kind?: unknown; entity?: unknown; enabled?: unknown };
          if (p.kind !== 'table' && p.kind !== 'collection') {
            return { ok: false, error: "params.kind must be 'table' or 'collection'" };
          }
          if (typeof p.entity !== 'string' || !p.entity.trim()) {
            return { ok: false, error: 'params.entity (string) is required' };
          }
          const result = await this.realtime.setBinding(
            projectId,
            p.kind,
            p.entity,
            p.enabled === true,
          );
          return { ok: true, result };
        }
        default:
          throw new ForbiddenException(`Action not allowed: ${req.action}`);
      }
    } catch (e: any) {
      if (e instanceof ForbiddenException) throw e;
      return { ok: false, error: e?.message?.slice(0, 500) || 'action failed' };
    }
  }

  /**
   * Live event stream for the IDE. Emits a `ready` snapshot then a heartbeat so
   * the connection stays warm; project mutations surface on the next poll of
   * listResources. (SSE is wired in the controller.)
   */
  eventStream(session: AdapterSessionClaims): Observable<AdapterEvent> {
    return new Observable((sub: Subscriber<AdapterEvent>) => {
      sub.next({ type: 'ready', payload: { account: session.email } });
      const beat = interval(20_000).subscribe(() =>
        sub.next({ type: 'heartbeat', payload: { ts: Date.now() } }),
      );
      return () => beat.unsubscribe();
    });
  }

  private encodeCursor(offset: number): string {
    return Buffer.from(String(offset), 'utf8').toString('base64url');
  }
  private decodeCursor(cursor?: string): number {
    if (!cursor) return 0;
    const n = parseInt(Buffer.from(cursor, 'base64url').toString('utf8'), 10);
    return Number.isFinite(n) && n >= 0 ? n : 0;
  }
}
