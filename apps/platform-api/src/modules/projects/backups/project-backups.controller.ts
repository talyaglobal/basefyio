import { Controller, Get, HttpCode, Param, Post, Query, UseGuards } from '@nestjs/common';
import { JwtOrPlatformTokenGuard } from '../../api-tokens/jwt-or-platform-token.guard';
import { ScopesGuard } from '../../api-tokens/scopes.guard';
import { Scopes } from '../../api-tokens/scopes.decorator';
import { CurrentUser, JwtPayload } from '../../../common/decorators/current-user.decorator';
import { BackupOffsiteService } from './backup-offsite.service';
import { BackupVerificationService } from './backup-verification.service';
import { isBackupEncryptionEnabled } from './backup-crypto';

/**
 * Backup health beyond the archive list: whether copies exist off the server
 * and whether the newest backup has been proven restorable.
 */
@Controller('projects')
@UseGuards(JwtOrPlatformTokenGuard, ScopesGuard)
export class ProjectBackupsController {
  constructor(
    private readonly offsite: BackupOffsiteService,
    private readonly verification: BackupVerificationService,
  ) {}

  /** Declared before the ':id' routes so "backups" is not read as a project id. ROOT only. */
  @Post('backups/offsite/reconcile')
  @HttpCode(202)
  async reconcileOffsite(@CurrentUser() user: JwtPayload) {
    return this.offsite.reconcileNow(user.sub);
  }

  @Get(':id/backups/health')
  @Scopes('backups:read')
  async health(@Param('id') id: string, @CurrentUser() user: JwtPayload) {
    const verifications = await this.verification.listForProject(id, user.sub, 10);
    const offsite = await this.offsite.healthForProject(id);
    return {
      offsite,
      localEncryption: isBackupEncryptionEnabled() && process.env.BACKUP_ENCRYPT_LOCAL?.trim().toLowerCase() === 'true',
      verification: {
        enabled: this.verification.enabled,
        running: this.verification.isRunning,
        latest: verifications[0] ?? null,
      },
      verifications,
    };
  }

  @Get(':id/backups/verifications')
  @Scopes('backups:read')
  async listVerifications(
    @Param('id') id: string,
    @Query('limit') limitRaw: string | undefined,
    @CurrentUser() user: JwtPayload,
  ) {
    const limit = limitRaw ? Number.parseInt(limitRaw, 10) : 10;
    return this.verification.listForProject(id, user.sub, Number.isFinite(limit) ? limit : 10);
  }

  /** Restore the newest auto-backup into a throwaway database now; the verdict lands in the list. */
  @Post(':id/backups/verify')
  @Scopes('backups:write')
  @HttpCode(202)
  async verify(@Param('id') id: string, @CurrentUser() user: JwtPayload) {
    return this.verification.startManual(id, user.sub);
  }
}
