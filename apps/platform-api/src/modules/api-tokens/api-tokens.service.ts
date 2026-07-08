import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { ALL_SCOPES } from './api-tokens.constants';
import { generateToken, hashToken } from './platform-token.util';

export interface CreateTokenInput {
  name: string;
  scopes: string[];
  teamId?: string;
  expiresAt?: string; // ISO
}

export interface VerifiedToken {
  id: string;
  userId: string;
  teamId: string | null;
  scopes: string[];
}

@Injectable()
export class ApiTokensService {
  constructor(private readonly prisma: PrismaService) {}

  private validate(input: CreateTokenInput): { scopes: string[]; expiresAt: Date | null } {
    if (!input?.name?.trim()) throw new BadRequestException('name is required');
    if (!Array.isArray(input.scopes) || input.scopes.length === 0) {
      throw new BadRequestException('at least one scope is required');
    }
    const scopes = [...new Set(input.scopes)];
    for (const s of scopes) {
      if (!ALL_SCOPES.has(s)) throw new BadRequestException(`unknown scope: ${s}`);
    }
    let expiresAt: Date | null = null;
    if (input.expiresAt) {
      const d = new Date(input.expiresAt);
      if (isNaN(d.getTime())) throw new BadRequestException('invalid expiresAt');
      if (d.getTime() <= Date.now()) throw new BadRequestException('expiresAt must be in the future');
      expiresAt = d;
    }
    return { scopes, expiresAt };
  }

  private async assertTeam(userId: string, teamId?: string) {
    if (!teamId) return;
    const m = await this.prisma.teamMember.findUnique({
      where: { teamId_userId: { teamId, userId } },
      select: { id: true },
    });
    if (!m) throw new ForbiddenException('You are not a member of that team');
  }

  /** Create a token. The raw secret is returned ONCE and never stored. */
  async create(userId: string, input: CreateTokenInput) {
    const { scopes, expiresAt } = this.validate(input);
    await this.assertTeam(userId, input.teamId);
    const { token, hash, prefix } = generateToken();
    const row = await this.prisma.platformApiToken.create({
      data: {
        userId,
        teamId: input.teamId ?? null,
        name: input.name.trim(),
        tokenPrefix: prefix,
        tokenHash: hash,
        scopes,
        expiresAt,
        createdBy: userId,
      },
      select: this.publicSelect,
    });
    return { ...row, token }; // token shown once
  }

  private readonly publicSelect = {
    id: true,
    name: true,
    tokenPrefix: true,
    scopes: true,
    teamId: true,
    status: true,
    expiresAt: true,
    lastUsedAt: true,
    createdAt: true,
  } as const;

  async list(userId: string) {
    return this.prisma.platformApiToken.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
      select: this.publicSelect,
    });
  }

  private async own(userId: string, id: string) {
    const t = await this.prisma.platformApiToken.findFirst({ where: { id, userId }, select: { id: true } });
    if (!t) throw new NotFoundException('Token not found');
  }

  async revoke(userId: string, id: string) {
    await this.own(userId, id);
    await this.prisma.platformApiToken.update({ where: { id }, data: { status: 'revoked' } });
    return { revoked: true };
  }

  /** Regenerate the secret (invalidates the old one). */
  async roll(userId: string, id: string) {
    await this.own(userId, id);
    const { token, hash, prefix } = generateToken();
    const row = await this.prisma.platformApiToken.update({
      where: { id },
      data: { tokenHash: hash, tokenPrefix: prefix, status: 'active', lastUsedAt: null },
      select: this.publicSelect,
    });
    return { ...row, token };
  }

  /** Verify a raw token; returns the owner + scopes, or throws. Bumps lastUsedAt. */
  async verify(rawToken: string): Promise<VerifiedToken> {
    const hash = hashToken(rawToken);
    const t = await this.prisma.platformApiToken.findUnique({
      where: { tokenHash: hash },
      select: { id: true, userId: true, teamId: true, scopes: true, status: true, expiresAt: true, lastUsedAt: true },
    });
    if (!t || t.status !== 'active') throw new Error('invalid token');
    if (t.expiresAt && t.expiresAt.getTime() <= Date.now()) throw new Error('expired token');
    // Throttle lastUsedAt writes to at most once per minute.
    if (!t.lastUsedAt || Date.now() - t.lastUsedAt.getTime() > 60_000) {
      this.prisma.platformApiToken
        .update({ where: { id: t.id }, data: { lastUsedAt: new Date() } })
        .catch(() => undefined);
    }
    return { id: t.id, userId: t.userId, teamId: t.teamId, scopes: t.scopes };
  }
}
