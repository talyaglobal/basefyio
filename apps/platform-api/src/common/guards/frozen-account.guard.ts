import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';

// Routes that remain accessible even when the account is FROZEN
const ALLOWED_PREFIXES = ['/api/billing', '/api/auth', '/api/stripe/webhook'];

@Injectable()
export class FrozenAccountGuard implements CanActivate {
  constructor(private readonly prisma: PrismaService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest();
    const user = request.user;

    // Unauthenticated requests are handled by the auth guard
    if (!user?.sub) return true;

    const path: string = request.path;
    if (ALLOWED_PREFIXES.some((p) => path.startsWith(p))) return true;

    // Look up the user's active team to check account status
    // user.sub is the Keycloak subject, which maps to User.id in DB
    const dbUser = await this.prisma.user.findUnique({
      where: { id: user.sub },
      select: {
        activeTeam: {
          select: { accountStatus: true },
        },
      },
    });

    if (dbUser?.activeTeam?.accountStatus === 'FROZEN') {
      throw new ForbiddenException({ code: 'ACCOUNT_FROZEN', message: 'Account is suspended. Please update your payment method.' });
    }

    return true;
  }
}
