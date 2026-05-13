#!/usr/bin/env pwsh
# Run this once on Windows side: `pwsh fix-build.ps1` (or `powershell -File fix-build.ps1`).
# It overwrites the files that Windows-side editors keep restoring to broken
# state. Close VS Code first (or at least save & close the tabs for these
# files) so the editor doesn't immediately overwrite your fix on next save.

$root = $PSScriptRoot
$files = @{}

$files['apps/platform-api/src/common/realtime/realtime-events.types.ts'] = @'
export type RealtimeEntityType =
  | 'feedback'
  | 'feedback_comment'
  | 'team'
  | 'team_invite'
  | 'team_member'
  | 'project'
  | 'project_activity';

export type RealtimeAction =
  | 'created'
  | 'updated'
  | 'deleted'
  | 'status_changed'
  | 'comment_added'
  | 'invite_sent'
  | 'invite_accepted'
  | 'invite_declined'
  | 'member_removed'
  | 'moved'
  | 'restored'
  | 'activity_appended';

export interface RealtimeEventEnvelope {
  eventId: string;
  traceId: string;
  emittedAt: string;
  feature: 'realtime_phase1';
  entityType: RealtimeEntityType;
  action: RealtimeAction;
  entityId: string;
  actorUserId?: string;
  teamId?: string;
  projectId?: string;
  userIds?: string[];
  payload?: Record<string, unknown>;
}
'@

$files['apps/platform-api/src/modules/projects/project-activity.module.ts'] = @'
import { Module } from '@nestjs/common';
import { PrismaModule } from '../../prisma/prisma.module';
import { ProjectActivityService } from './project-activity.service';
import { RealtimeEventsService } from '../../common/realtime/realtime-events.service';
import { RealtimeStreamService } from '../../common/realtime/realtime-stream.service';

@Module({
  imports: [PrismaModule],
  providers: [ProjectActivityService, RealtimeEventsService, RealtimeStreamService],
  exports: [ProjectActivityService, RealtimeEventsService],
})
export class ProjectActivityModule {}
'@

foreach ($rel in $files.Keys) {
    $abs = Join-Path $root $rel
    $content = $files[$rel]
    # Force LF line endings (no CRLF) so Windows-side word-wrap formatters
    # have nothing to choke on.
    $lf = $content -replace "`r`n", "`n"
    if (-not $lf.EndsWith("`n")) { $lf += "`n" }
    # Use raw byte write so PowerShell doesn't sneak a BOM or CRLF in.
    [System.IO.File]::WriteAllBytes(
        $abs,
        [System.Text.Encoding]::UTF8.GetBytes($lf)
    )
    $lines = (Get-Content $abs -Raw).Split("`n").Count - 1
    Write-Host "Fixed: $rel ($lines lines)"
}

Write-Host ""
Write-Host "All done. Now run:"
Write-Host "  cd apps/platform-api && npm run build"
Write-Host ""
Write-Host "If npm run build still complains, your editor is overriding"
Write-Host "the on-disk file. Close VS Code completely first."
