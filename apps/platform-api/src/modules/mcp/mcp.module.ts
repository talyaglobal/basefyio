import { Module } from '@nestjs/common';
import { ProjectsModule } from '../projects/projects.module';
import { ProjectActivityModule } from '../projects/project-activity.module';
import { SqlModule } from '../sql/sql.module';
import { StorageModule } from '../storage/storage.module';
import { AuthModule } from '../auth/auth.module';
import { TeamsModule } from '../teams/teams.module';
import { McpController } from './mcp.controller';
import { McpService } from './mcp.service';

/** POST /api/mcp — the MCP server for platform API tokens (ApiTokensModule is global). */
@Module({
  imports: [ProjectsModule, ProjectActivityModule, SqlModule, StorageModule, AuthModule, TeamsModule],
  controllers: [McpController],
  providers: [McpService],
})
export class McpModule {}
