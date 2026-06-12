import {
  CanActivate, ExecutionContext, Injectable, ForbiddenException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { PrismaService } from '../../prisma/prisma.service';

export const REQUIRED_ITEM_PERMISSION = 'requiredItemPermission';
export const RequireItemPermission = (permission: 'read' | 'write' | 'delete') =>
  Reflect.metadata(REQUIRED_ITEM_PERMISSION, permission);

/**
 * Checks that the JWT's `app_role` claim has the required permission
 * on the target entity.
 *
 * Falls through (allows) when:
 * - No `app_role` claim (the request uses a service token — checked by JwtOrApiKeyGuard)
 * - Blueprint has no ApplicationVersion with roles (dev/admin mode)
 */
@Injectable()
export class ItemPolicyGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly prisma: PrismaService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const required = this.reflector.get<'read' | 'write' | 'delete'>(
      REQUIRED_ITEM_PERMISSION,
      context.getHandler(),
    );
    if (!required) return true; // no annotation → allow

    const request = context.switchToHttp().getRequest();
    const user = request.user as Record<string, unknown> | undefined;
    const appRole = user?.app_role as string | undefined;

    // No app_role → service token or admin — allow
    if (!appRole) return true;

    const { projectId, entityName } = request.params as Record<string, string>;
    if (!projectId || !entityName) return true;

    // Look up blueprint roles for this project
    const blueprint = await (this.prisma as any).blueprint.findFirst({
      where: { projectId },
      select: { currentVersionId: true },
    });
    if (!blueprint?.currentVersionId) return true; // no blueprint → allow

    const version = await (this.prisma as any).applicationVersion.findUnique({
      where: { id: blueprint.currentVersionId },
      select: { applicationModel: true },
    });

    const appModel = version?.applicationModel as {
      roles?: Array<{ name: string; permissions: Record<string, string[]> }>;
    } | undefined;

    const role = appModel?.roles?.find((r) => r.name === appRole);
    if (!role) throw new ForbiddenException(`Role '${appRole}' not found in application model`);

    const perms: string[] = role.permissions[entityName] ?? [];
    if (!perms.includes(required)) {
      throw new ForbiddenException(`Role '${appRole}' lacks '${required}' on '${entityName}'`);
    }

    return true;
  }
}
