import { CanActivate, ExecutionContext, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';

/** What a project gets from a Supabase-compatible route before a ROOT turns the surface on. */
export const SUPABASE_COMPAT_DISABLED = 'The Supabase-compatible API is not enabled for this project';

/**
 * The Supabase-compatible surfaces (`/api/auth/v1`, `/api/storage/v1`, the storage catalog
 * routes) serve only projects with `supabaseCompat` on. Every other project answers 404, as
 * if the routes did not exist — so shipping the surfaces changes nothing for a project
 * until it is enabled for it.
 *
 * Runs after the guard that names the project: the route's `:projectId`, or the project
 * of the API key `ApiKeyGuard` admitted.
 */
@Injectable()
export class SupabaseCompatGuard implements CanActivate {
  constructor(private readonly prisma: PrismaService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest();
    const projectId: unknown = req.params?.projectId ?? req.apiKeyPayload?.projectId;
    if (typeof projectId !== 'string' || !projectId) throw new NotFoundException(SUPABASE_COMPAT_DISABLED);
    if (!(await supabaseCompatEnabled(this.prisma, projectId))) {
      throw new NotFoundException(SUPABASE_COMPAT_DISABLED);
    }
    return true;
  }
}

/** Whether the project exists and has the Supabase-compatible surfaces turned on. */
export async function supabaseCompatEnabled(prisma: PrismaService, projectId: string): Promise<boolean> {
  const row = await prisma.project.findUnique({ where: { id: projectId }, select: { supabaseCompat: true } });
  return row?.supabaseCompat === true;
}
