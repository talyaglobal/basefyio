// A 32-byte key before anything reads the env (field-crypto caches it lazily).
process.env.DB_CRED_ENC_KEY = Buffer.from('0123456789abcdef0123456789abcdef').toString('base64');

jest.mock('@prisma/client', () => ({
  PrismaClient: class {
    middleware: ((params: any, next: (p: any) => Promise<any>) => Promise<any>) | null = null;
    $use(fn: any) {
      this.middleware = fn;
    }
    async $connect() {}
    async $disconnect() {}
  },
}));

import { isEncrypted, decryptField } from '../common/crypto/field-crypto';
import { PrismaService } from './prisma.service';

/** The middleware under test, with a `next` that echoes what it was given. */
function middleware() {
  const svc: any = new PrismaService();
  svc.installCredentialCrypto();
  return svc.middleware as (params: any, next: (p: any) => Promise<any>) => Promise<any>;
}

describe('PrismaService credential middleware', () => {
  it('encrypts both the owner and the read-only password on write', async () => {
    const mw = middleware();
    const seen: any[] = [];
    await mw(
      { model: 'Project', action: 'create', args: { data: { dbPassword: 'owner-pw', dbReadonlyPassword: 'ro-pw', name: 'x' } } },
      async (p) => {
        seen.push(p.args.data);
        return null;
      },
    );
    expect(isEncrypted(seen[0].dbPassword)).toBe(true);
    expect(isEncrypted(seen[0].dbReadonlyPassword)).toBe(true);
    expect(decryptField(seen[0].dbPassword)).toBe('owner-pw');
    expect(decryptField(seen[0].dbReadonlyPassword)).toBe('ro-pw');
    expect(seen[0].name).toBe('x');
  });

  it('handles upsert create/update branches and leaves null or absent fields alone', async () => {
    const mw = middleware();
    const args = {
      where: { id: 'p1' },
      create: { dbPassword: 'a', dbReadonlyPassword: null },
      update: { dbReadonlyPassword: 'b' },
    };
    await mw({ model: 'Project', action: 'upsert', args }, async () => null);
    expect(isEncrypted(args.create.dbPassword)).toBe(true);
    expect(args.create.dbReadonlyPassword).toBeNull();
    expect(isEncrypted(args.update.dbReadonlyPassword as string)).toBe(true);
  });

  it('does not encrypt twice', async () => {
    const mw = middleware();
    const once: any = { dbPassword: 'a', dbReadonlyPassword: 'b' };
    await mw({ model: 'Project', action: 'update', args: { data: once } }, async () => null);
    const { dbPassword, dbReadonlyPassword } = once;
    await mw({ model: 'Project', action: 'update', args: { data: once } }, async () => null);
    expect(once.dbPassword).toBe(dbPassword);
    expect(once.dbReadonlyPassword).toBe(dbReadonlyPassword);
  });

  it('decrypts both fields on the way out, for single rows and arrays', async () => {
    const mw = middleware();
    const stored = { dbPassword: 'enc', dbReadonlyPassword: 'enc' } as any;
    await mw({ model: 'Project', action: 'update', args: { data: { dbPassword: 'o', dbReadonlyPassword: 'r' } } }, async (p) => {
      stored.dbPassword = p.args.data.dbPassword;
      stored.dbReadonlyPassword = p.args.data.dbReadonlyPassword;
      return null;
    });

    const one = await mw({ model: 'Project', action: 'findFirst', args: {} }, async () => ({ ...stored }));
    expect(one).toEqual({ dbPassword: 'o', dbReadonlyPassword: 'r' });

    const many = await mw({ model: 'Project', action: 'findMany', args: {} }, async () => [{ ...stored }, { ...stored, dbReadonlyPassword: null }]);
    expect(many).toEqual([
      { dbPassword: 'o', dbReadonlyPassword: 'r' },
      { dbPassword: 'o', dbReadonlyPassword: null },
    ]);
  });

  it('ignores other models entirely', async () => {
    const mw = middleware();
    const data = { dbPassword: 'plain' };
    const result = await mw({ model: 'Team', action: 'create', args: { data } }, async () => ({ dbPassword: 'plain' }));
    expect(data.dbPassword).toBe('plain');
    expect(result).toEqual({ dbPassword: 'plain' });
  });
});
