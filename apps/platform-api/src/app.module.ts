import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { PrismaModule } from './prisma/prisma.module';
import { GuardsModule } from './common/guards/guards.module';
import { EmailModule } from './modules/email/email.module';
import { AuthModule } from './modules/auth/auth.module';
import { TeamsModule } from './modules/teams/teams.module';
import { ProjectsModule } from './modules/projects/projects.module';
import { SqlModule } from './modules/sql/sql.module';
import { StorageModule } from './modules/storage/storage.module';
import { FeedbackModule } from './modules/feedback/feedback.module';
import configuration from './config/configuration';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      load: [configuration],
    }),
    PrismaModule,
    GuardsModule,
    EmailModule,
    AuthModule,
    TeamsModule,
    ProjectsModule,
    SqlModule,
    StorageModule,
    FeedbackModule,
  ],
})
export class AppModule {}
