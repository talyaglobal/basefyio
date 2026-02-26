import { Module, Global } from '@nestjs/common';
import { PgBouncerService } from './pgbouncer.service';

@Global()
@Module({
  providers: [PgBouncerService],
  exports: [PgBouncerService],
})
export class PgBouncerModule {}
