import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { MODULE_KEY } from '../decorators/require-module.decorator';
import { PrismaService } from '../../prisma/prisma.service';

@Injectable()
export class ModuleEnabledGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly prisma: PrismaService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const module = this.reflector.getAllAndOverride<string>(MODULE_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!module) return true;

    const req = context.switchToHttp().getRequest();
    // Resolve projectId from the three common locations; operations routes use body.projectId.
    const projectId: string | undefined =
      req.params?.projectId ??
      req.body?.projectId ??
      req.query?.projectId;

    // No projectId resolvable at guard time — downstream service handles 404 / ownership.
    if (!projectId) return true;

    const project = await this.prisma.project.findUnique({
      where: { id: projectId },
      select: { modules: true },
    });
    // Project not found — let the service throw the canonical NotFoundException.
    if (!project) return true;

    const flags = (project.modules as Record<string, unknown>) ?? {};
    if (flags[module] === false) {
      throw new ForbiddenException(`Module '${module}' is not enabled for this project`);
    }
    return true;
  }
}
