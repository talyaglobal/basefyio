import { Controller, Delete, Get, HttpCode, Param, Post, Query, Res, UseGuards } from '@nestjs/common';
import { Response } from 'express';
import { JwtOrPlatformTokenGuard } from '../../api-tokens/jwt-or-platform-token.guard';
import { ScopesGuard } from '../../api-tokens/scopes.guard';
import { Scopes } from '../../api-tokens/scopes.decorator';
import { CurrentUser, JwtPayload } from '../../../common/decorators/current-user.decorator';
import { BackupOffsiteService } from './backup-offsite.service';
import { BackupVerificationService } from './backup-verification.service';
import { isBackupEncryptionEnabled } from './backup-crypto';
import { ProjectExportService } from '../project-export.service';

/** `kind` query parameter: which store the archive lives in (default: manual exports). */
function parseKind(raw: string | undefined): 'manual' | 'auto' {
  return raw === 'auto' ? 'auto' : 'manual';
}

/**
 * Backup health beyond the archive list: whether copies exist off the server
 * and whether the newest backup has been proven restorable. Also the archive
 * actions the list itself needs: take a backup now, download one, delete one.
 */
@Controller('projects')
@UseGuards(JwtOrPlatformTokenGuard, ScopesGuard)
export class ProjectBackupsController {
  constructor(
    private readonly offsite: BackupOffsiteService,
    private readonly verification: BackupVerificationService,
    private readonly projectExport: ProjectExportService,
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

  /**
   * Take a backup now (database, auth and config), kept like the nightly ones.
   * Returns the export job id; follow it with the export job status/events routes.
   */
  @Post(':id/backups/run')
  @Scopes('backups:write')
  @HttpCode(202)
  async runBackup(@Param('id') id: string, @CurrentUser() user: JwtPayload) {
    return this.projectExport.startOnDemandBackup(id, user.sub);
  }

  /** Download one archive from the list as a plain ZIP (decrypted when stored encrypted). */
  @Get(':id/backups/download')
  @Scopes('backups:read')
  async download(
    @Param('id') id: string,
    @Query('objectKey') objectKey: string,
    @Query('kind') kind: string | undefined,
    @CurrentUser() user: JwtPayload,
    @Res() res: Response,
  ) {
    const file = await this.projectExport.downloadCloudBackup(id, user.sub, objectKey, parseKind(kind));
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="${file.filename.replace(/"/g, '')}"`);
    if (file.size != null) res.setHeader('Content-Length', String(file.size));
    file.stream.on('error', () => res.destroy());
    file.stream.pipe(res);
  }

  /** Delete a manual export or an on-demand backup. Nightly backups expire on their own. */
  @Delete(':id/backups/archive')
  @Scopes('backups:write')
  async deleteArchive(
    @Param('id') id: string,
    @Query('objectKey') objectKey: string,
    @Query('kind') kind: string | undefined,
    @CurrentUser() user: JwtPayload,
  ) {
    return this.projectExport.deleteCloudBackup(id, user.sub, objectKey, parseKind(kind));
  }
}
