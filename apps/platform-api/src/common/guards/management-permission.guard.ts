import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import {
  MANAGEMENT_PERMISSION_KEY,
  ManagementPermission,
} from '../decorators/management-permission.decorator';
import { PrismaService } from '../../prisma/prisma.service';

@Injectable()
export class ManagementPermissionGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly prisma: PrismaService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const requiredPermission = this.reflector.getAllAndOverride<ManagementPermission>(
      MANAGEMENT_PERMISSION_KEY,
      [context.getHandler(), context.getClass()],
    );
    if (!requiredPermission) return true;

    const req = context.switchToHttp().getRequest();
    const sub: string | undefined = req.user?.sub;
    if (!sub) throw new ForbiddenException('Forbidden');

    const user = await this.prisma.user.findUnique({
      where: { id: sub },
      select: { role: true },
    });
    if (!user) throw new ForbiddenException('Forbidden');
    if (user.role === 'ROOT') return true;

    const rolePermission = await this.prisma.rolePermission.findUnique({
      where: { role: user.role },
      select: {
        canAccessManagement: true,
        canManageUsers: true,
        canManageTeams: true,
        canManagePlans: true,
        canManageUserPackages: true,
        canModerateFeedback: true,
        canViewAuditLogs: true,
        canViewRootAlerts: true,
      },
    });

    if (!rolePermission || rolePermission[requiredPermission] !== true) {
      throw new ForbiddenException(
        `You do not have permission: ${requiredPermission}`,
      );
    }

    return true;
  }
}
