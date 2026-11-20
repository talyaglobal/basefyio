import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';

export const DATA_API_DISABLED = 'The Data API is disabled for this project';

/**
 * The REST data API (`/api/rest/v1/:table`, `/rpc`, `/api/rest/v1/collections`) serves only
 * projects whose Data API setting is on. A project that turned it off answers 403 on those
 * routes for every key; the dashboard, the SQL editor, auth and storage keep working, since
 * they do not pass through here.
 *
 * Runs after `ApiKeyGuard`, which names the project. Leaves the project's exposed REST
 * schemas on `req.restExposedSchemas` for the PostgREST profile headers.
 */
@Injectable()
export class DataApiGuard implements CanActivate {
  constructor(private readonly prisma: PrismaService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest();
    const projectId: unknown = req.apiKeyPayload?.projectId;
    if (typeof projectId !== 'string' || !projectId) throw new ForbiddenException(DATA_API_DISABLED);
    const row = await this.prisma.project.findUnique({
      where: { id: projectId },
      select: { dataApiEnabled: true, restExposedSchemas: true },
    });
    if (row?.dataApiEnabled === false) throw new ForbiddenException(DATA_API_DISABLED);
    // The schemas a profile header may choose (#264), read on the same row so a
    // request costs no extra query. The controller validates them again.
    req.restExposedSchemas = Array.isArray(row?.restExposedSchemas) ? row!.restExposedSchemas : [];
    return true;
  }
}
