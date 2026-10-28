import { Module } from '@nestjs/common';
import { PrismaModule } from '../../prisma/prisma.module';
import { ProjectRlsRunner } from './project-rls-runner';

/**
 * Access to a project's own Postgres database as the owner or under RLS.
 * Prisma-only: it reads the connection details and nothing else, so any
 * module may import it without pulling in the projects module.
 */
@Module({
  imports: [PrismaModule],
  providers: [ProjectRlsRunner],
  exports: [ProjectRlsRunner],
})
export class ProjectDbModule {}
