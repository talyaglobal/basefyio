import { Module, Global } from '@nestjs/common';
import { PgBouncerService } from './pgbouncer.service';
import { DbTlsNoticeService } from './db-tls-notice.service';

@Global()
@Module({
  providers: [PgBouncerService, DbTlsNoticeService],
  exports: [PgBouncerService],
})
export class PgBouncerModule {}
