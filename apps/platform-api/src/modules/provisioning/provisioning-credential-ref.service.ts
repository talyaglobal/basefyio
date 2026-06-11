import {
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { v4 as uuidv4 } from 'uuid';
import { PrismaService } from '../../prisma/prisma.service';
import { CreateCredentialRefDto } from './dto/create-credential-ref.dto';

// ── Response types ────────────────────────────────────────

export interface CredentialRefResponse {
  credentialRefId: string;
  teamId: string;
  label: string;
  openbaoPath: string;
  provider: string;
  createdAt: string;
}

export interface CredentialRefListItem {
  credentialRefId: string;
  label: string;
  openbaoPath: string;
  provider: string;
  createdAt: string;
}

// ── Service ───────────────────────────────────────────────

@Injectable()
export class ProvisioningCredentialRefService {
  constructor(private readonly prisma: PrismaService) {}

  // ── Ownership guard ───────────────────────────────────────

  private async assertTeamMember(teamId: string, userId: string): Promise<void> {
    const m = await this.prisma.teamMember.findUnique({
      where: { teamId_userId: { teamId, userId } },
    });
    if (!m) throw new ForbiddenException('Not a member of this team');
  }

  // ── Create ────────────────────────────────────────────────

  async create(
    userId: string,
    dto: CreateCredentialRefDto,
  ): Promise<CredentialRefResponse> {
    await this.assertTeamMember(dto.teamId, userId);

    const ref = await this.prisma.provisioningCredentialRef.create({
      data: {
        id: uuidv4(),
        teamId: dto.teamId,
        label: dto.label,
        openbaoPath: dto.openbaoPath,
        ...(dto.provider ? { provider: dto.provider } : {}),
      },
    });

    return {
      credentialRefId: ref.id,
      teamId: ref.teamId,
      label: ref.label,
      openbaoPath: ref.openbaoPath,
      provider: ref.provider,
      createdAt: ref.createdAt.toISOString(),
    };
  }

  // ── List ──────────────────────────────────────────────────

  async list(userId: string, teamId: string): Promise<CredentialRefListItem[]> {
    await this.assertTeamMember(teamId, userId);

    const refs = await this.prisma.provisioningCredentialRef.findMany({
      where: {
        teamId,
        revokedAt: null,
      },
      orderBy: { createdAt: 'asc' },
      select: {
        id: true,
        label: true,
        openbaoPath: true,
        provider: true,
        createdAt: true,
      },
    });

    return refs.map((r) => ({
      credentialRefId: r.id,
      label: r.label,
      openbaoPath: r.openbaoPath,
      provider: r.provider,
      createdAt: r.createdAt.toISOString(),
    }));
  }

  // ── Revoke (soft-delete) ──────────────────────────────────

  async revoke(userId: string, id: string): Promise<void> {
    // Load the ref — 404 if it doesn't exist
    const ref = await this.prisma.provisioningCredentialRef.findUnique({
      where: { id },
      select: { teamId: true, revokedAt: true },
    });

    if (!ref) throw new NotFoundException('Credential reference not found');

    // Ownership check
    await this.assertTeamMember(ref.teamId, userId);

    // 409 if already revoked
    if (ref.revokedAt) {
      throw new ConflictException('Credential reference has already been revoked');
    }

    await this.prisma.provisioningCredentialRef.update({
      where: { id },
      data: { revokedAt: new Date() },
    });
  }
}
