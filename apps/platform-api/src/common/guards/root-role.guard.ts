import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';

/**
 * Allows only users with {@link UserRole.ROOT} in the platform database.
 */
@Injectable()
export class RootRoleGuard implements CanActivate {
  constructor(private readonly prisma: PrismaService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest();
    const sub: string | undefined = req.user?.sub;
    if (!sub) throw new ForbiddenException('Forbidden');

    const user = await this.prisma.user.findUnique({
      where: { id: sub },
      select: { role: true },
    });
    if (user?.role !== 'ROOT') {
      throw new ForbiddenException('Only root users can access this resource');
    }
    return true;
  }
}
