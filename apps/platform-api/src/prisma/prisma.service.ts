import { Injectable, Logger, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import {
  decryptField,
  encryptField,
  isEncrypted,
  isEncryptionEnabled,
} from '../common/crypto/field-crypto';

const WRITE_ACTIONS = new Set([
  'create',
  'update',
  'upsert',
  'updateMany',
  'createMany',
]);

@Injectable()
export class PrismaService
  extends PrismaClient
  implements OnModuleInit, OnModuleDestroy
{
  private readonly logger = new Logger(PrismaService.name);

  async onModuleInit() {
    this.installCredentialCrypto();
    await this.$connect();
    // Encrypt any existing plaintext project passwords (no-op without a key).
    this.backfillProjectCredentials().catch((e) =>
      this.logger.warn(`Project credential backfill skipped: ${e?.message ?? e}`),
    );
  }

  async onModuleDestroy() {
    await this.$disconnect();
  }

  /**
   * Transparently encrypt Project.dbPassword on write and decrypt on read, so
   * the value is stored encrypted at rest while every existing reader keeps
   * receiving plaintext. No-op unless DB_CRED_ENC_KEY is set; plaintext (not yet
   * migrated) values pass through both ways, so the rollout cannot break reads.
   */
  private installCredentialCrypto() {
    this.$use(async (params, next) => {
      if (
        params.model === 'Project' &&
        params.action &&
        WRITE_ACTIONS.has(params.action)
      ) {
        const a: any = params.args ?? {};
        if (a.data) encryptDbPassword(a.data);
        if (a.create) encryptDbPassword(a.create); // upsert
        if (a.update) encryptDbPassword(a.update); // upsert
      }
      const result = await next(params);
      if (params.model === 'Project') decryptResult(result);
      return result;
    });
  }

  private async backfillProjectCredentials() {
    if (!isEncryptionEnabled()) return;
    // Filter on the STORED value (runs before decryption) to find plaintext rows.
    const rows = await this.project.findMany({
      where: { NOT: { dbPassword: { startsWith: 'enc:v1:' } } },
      select: { id: true, dbPassword: true },
    });
    if (rows.length === 0) return;
    let migrated = 0;
    for (const row of rows) {
      // row.dbPassword is plaintext here. Re-saving runs it through the write
      // hook, which encrypts it.
      await this.project.update({
        where: { id: row.id },
        data: { dbPassword: row.dbPassword },
      });
      migrated++;
    }
    this.logger.log(`Encrypted ${migrated} project DB credential(s) at rest.`);
  }
}

function encryptDbPassword(obj: any) {
  if (obj && typeof obj.dbPassword === 'string' && !isEncrypted(obj.dbPassword)) {
    obj.dbPassword = encryptField(obj.dbPassword);
  }
}

function decryptResult(result: any) {
  if (!result) return;
  if (Array.isArray(result)) {
    for (const r of result) decryptOne(r);
  } else {
    decryptOne(result);
  }
}

function decryptOne(r: any) {
  if (r && typeof r.dbPassword === 'string' && isEncrypted(r.dbPassword)) {
    r.dbPassword = decryptField(r.dbPassword);
  }
}
