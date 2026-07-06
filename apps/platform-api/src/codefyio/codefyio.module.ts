import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { ProjectsModule } from '../modules/projects/projects.module';
import { SqlModule } from '../modules/sql/sql.module';
import { RealtimeDataModule } from '../modules/realtime-data/realtime-data.module';
import { CodefyioController } from './codefyio.controller';
import { CodefyioService } from './codefyio.service';
import { CodefyioJwtService } from './codefyio-jwt.service';
import { CodefyioSessionGuard } from './codefyio-session.guard';

@Module({
  imports: [PrismaModule, ProjectsModule, SqlModule, RealtimeDataModule],
  controllers: [CodefyioController],
  providers: [CodefyioService, CodefyioJwtService, CodefyioSessionGuard],
  exports: [CodefyioService, CodefyioJwtService],
})
export class CodefyioModule {}
