import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';

export interface ApiKeyPayload {
  projectId: string;
  role: 'anon' | 'service';
}

@Injectable()
export class ApiKeyGuard implements CanActivate {
  constructor(private readonly prisma: PrismaService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest();
    const apiKey = request.headers['apikey'];

    if (!apiKey) {
      throw new UnauthorizedException('Missing apikey header');
    }

    const project = await this.prisma.project.findFirst({
      where: {
        OR: [{ anonKey: apiKey }, { serviceKey: apiKey }],
        status: 'ACTIVE',
      },
      select: { id: true, anonKey: true, serviceKey: true },
    });

    if (!project) {
      throw new UnauthorizedException('Invalid API key');
    }

    request.apiKeyPayload = {
      projectId: project.id,
      role: project.serviceKey === apiKey ? 'service' : 'anon',
    } as ApiKeyPayload;

    return true;
  }
}
