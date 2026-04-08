import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PassportStrategy } from '@nestjs/passport';
import { Strategy, ExtractJwt } from 'passport-jwt';
import { passportJwtSecret } from 'jwks-rsa';
import { JwtPayload } from '../../../common/decorators/current-user.decorator';
import { PrismaService } from '../../../prisma/prisma.service';

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  constructor(
    config: ConfigService,
    private readonly prisma: PrismaService,
  ) {
    const keycloakUrl = config.get<string>('keycloak.url');

    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      secretOrKeyProvider: passportJwtSecret({
        cache: true,
        rateLimit: true,
        jwksRequestsPerMinute: 10,
        jwksUri: `${keycloakUrl}/realms/master/protocol/openid-connect/certs`,
      }),
      algorithms: ['RS256'],
    });
  }

  async validate(payload: Record<string, any>): Promise<JwtPayload> {
    const tokenSub = String(payload.sub || '');
    const preferredUsername =
      typeof payload.preferred_username === 'string'
        ? payload.preferred_username.trim().toLowerCase()
        : '';
    const tokenEmail =
      (typeof payload.email === 'string' ? payload.email.trim().toLowerCase() : '') ||
      (preferredUsername.includes('@') ? preferredUsername : '');

    let resolvedSub = tokenSub;
    if (tokenSub && tokenEmail) {
      const bySub = await this.prisma.user.findUnique({
        where: { id: tokenSub },
        select: { id: true },
      });
      if (!bySub) {
        const byEmail = await this.prisma.user.findUnique({
          where: { email: tokenEmail },
          select: { id: true },
        });
        if (byEmail?.id) {
          // Cross-provider social sign-in support: keep one app user per email.
          resolvedSub = byEmail.id;
        }
      }
    }

    return {
      sub: resolvedSub,
      email:
        (typeof payload.email === 'string' && payload.email.trim()) ||
        (preferredUsername.includes('@') ? preferredUsername : ''),
      preferred_username:
        (typeof payload.preferred_username === 'string' && payload.preferred_username) ||
        (typeof payload.email === 'string' ? payload.email : ''),
      roles: payload.realm_access?.roles ?? [],
      given_name: payload.given_name,
      family_name: payload.family_name,
      name: payload.name,
    };
  }
}
