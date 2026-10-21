import { execFile } from 'child_process';
import { randomBytes } from 'crypto';
import { existsSync } from 'fs';
import { mkdtemp, readFile, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join, resolve } from 'path';
import { Readable } from 'stream';
import { promisify } from 'util';
import {
  BFENC_HEADER_LENGTH,
  BFENC_OVERHEAD,
  BackupDecryptError,
  createDecryptStream,
  createEncryptStream,
  encryptedSize,
  getBackupKey,
  keyFingerprint,
  parseBackupKey,
  plaintextSize,
  resetBackupKeyCache,
} from './backup-crypto';

const execFileAsync = promisify(execFile);

const KEY = Buffer.from('0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef', 'hex');
const OTHER_KEY = Buffer.from('ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff', 'hex');

function* chunks(buf: Buffer, size: number) {
  if (buf.length === 0) return;
  for (let i = 0; i < buf.length; i += size) yield buf.subarray(i, i + size);
}

async function collect(stream: NodeJS.ReadableStream): Promise<Buffer> {
  const out: Buffer[] = [];
  for await (const c of stream) out.push(Buffer.isBuffer(c) ? c : Buffer.from(c as string));
  return Buffer.concat(out);
}

function encrypt(key: Buffer, plain: Buffer, chunkSize = 64 * 1024) {
  return collect(Readable.from(chunks(plain, chunkSize)).pipe(createEncryptStream(key)));
}

function decrypt(key: Buffer, enc: Buffer, chunkSize = 64 * 1024) {
  return collect(Readable.from(chunks(enc, chunkSize)).pipe(createDecryptStream(key)));
}

describe('BFENC1 backup encryption', () => {
  it.each([
    ['empty', 0],
    ['one byte', 1],
    ['one tag length', 16],
    ['one mebibyte', 1024 * 1024],
  ])('round-trips %s', async (_label, size) => {
    const plain = randomBytes(size);
    const enc = await encrypt(KEY, plain);
    expect(enc.length).toBe(encryptedSize(plain.length));
    expect(enc.length).toBe(plain.length + BFENC_OVERHEAD);
    expect(plaintextSize(enc.length)).toBe(plain.length);
    expect(enc.subarray(0, 6).toString('ascii')).toBe('BFENC1');
    expect(enc[6]).toBe(1);
    expect(enc.subarray(7, 11).equals(keyFingerprint(KEY))).toBe(true);
    const dec = await decrypt(KEY, enc);
    expect(dec.equals(plain)).toBe(true);
  });

  it('round-trips when the stream arrives in awkward chunk sizes', async () => {
    const plain = randomBytes(5000);
    const enc = await encrypt(KEY, plain, 7);
    for (const size of [1, 3, 16, 17, 23, 24, 39, 1000]) {
      const dec = await decrypt(KEY, enc, size);
      expect(dec.equals(plain)).toBe(true);
    }
  });

  it('rejects a ciphertext with a flipped byte as an authentication failure', async () => {
    const enc = await encrypt(KEY, randomBytes(2048));
    enc[BFENC_HEADER_LENGTH + 100] ^= 0x01;
    await expect(decrypt(KEY, enc)).rejects.toMatchObject({ reason: 'authentication' });
  });

  it('rejects a tampered IV (header is bound as AAD)', async () => {
    const enc = await encrypt(KEY, randomBytes(512));
    enc[BFENC_HEADER_LENGTH - 1] ^= 0x01;
    await expect(decrypt(KEY, enc)).rejects.toBeInstanceOf(BackupDecryptError);
  });

  it('says "wrong key" from the fingerprint before touching the body', async () => {
    const enc = await encrypt(KEY, randomBytes(4096));
    const dec = createDecryptStream(OTHER_KEY);
    const emitted: Buffer[] = [];
    dec.on('data', (c: Buffer) => emitted.push(c));
    const failure = new Promise<BackupDecryptError>((resolve) => dec.on('error', resolve));
    Readable.from(chunks(enc, 1024)).pipe(dec);
    const err = await failure;
    expect(err.reason).toBe('wrong-key');
    expect(err.message).toMatch(/BACKUP_ENC_KEY does not match/);
    expect(emitted).toHaveLength(0);
  });

  it('refuses a file that is not BFENC1 and one that is truncated', async () => {
    await expect(decrypt(KEY, Buffer.from('PK\u0003\u0004 this is a zip, not an encrypted backup'))).rejects.toMatchObject({
      reason: 'not-encrypted',
    });
    const enc = await encrypt(KEY, randomBytes(100));
    // Header cut short, or too few bytes after it to hold a tag: reported as truncated.
    await expect(decrypt(KEY, enc.subarray(0, 10))).rejects.toMatchObject({ reason: 'truncated' });
    await expect(decrypt(KEY, enc.subarray(0, 23 + 10))).rejects.toMatchObject({ reason: 'truncated' });
    // Cut inside the body: the last 16 bytes are then ciphertext read as a tag. The
    // format carries no length, so this is indistinguishable from tampering and
    // fails authentication — never yields a short plaintext.
    await expect(decrypt(KEY, enc.subarray(0, enc.length - 20))).rejects.toMatchObject({ reason: 'authentication' });
  });

  it('refuses an unsupported version byte', async () => {
    const enc = await encrypt(KEY, randomBytes(10));
    enc[6] = 0x02;
    await expect(decrypt(KEY, enc)).rejects.toMatchObject({ reason: 'unsupported-version' });
  });

  it('insists on a 32-byte key', () => {
    expect(() => createEncryptStream(Buffer.alloc(16))).toThrow(/32 bytes/);
    expect(() => createDecryptStream(Buffer.alloc(31))).toThrow(/32 bytes/);
  });
});

describe('BACKUP_ENC_KEY parsing', () => {
  const original = process.env.BACKUP_ENC_KEY;
  afterEach(() => {
    if (original === undefined) delete process.env.BACKUP_ENC_KEY;
    else process.env.BACKUP_ENC_KEY = original;
    resetBackupKeyCache();
  });

  it('accepts 64 hex characters and base64 of 32 bytes, rejects anything else', () => {
    expect(parseBackupKey(KEY.toString('hex'))?.equals(KEY)).toBe(true);
    expect(parseBackupKey(KEY.toString('base64'))?.equals(KEY)).toBe(true);
    expect(parseBackupKey(randomBytes(31).toString('base64'))).toBeNull();
    expect(parseBackupKey('')).toBeNull();
    expect(parseBackupKey(undefined)).toBeNull();
    expect(parseBackupKey('   ')).toBeNull();
  });

  it('caches the configured key per process until reset', () => {
    process.env.BACKUP_ENC_KEY = KEY.toString('hex');
    resetBackupKeyCache();
    expect(getBackupKey()?.equals(KEY)).toBe(true);
    process.env.BACKUP_ENC_KEY = OTHER_KEY.toString('hex');
    expect(getBackupKey()?.equals(KEY)).toBe(true);
    resetBackupKeyCache();
    expect(getBackupKey()?.equals(OTHER_KEY)).toBe(true);
  });
});

describe('scripts/backup-decrypt.mjs reads what the service writes', () => {
  // src/modules/projects/backups → six levels up is the repository root.
  const script = resolve(__dirname, '../../../../../../scripts/backup-decrypt.mjs');
  let dir: string;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'bfenc-spec-'));
  });
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('decrypts a service-encrypted file byte for byte', async () => {
    if (!existsSync(script)) {
      // The operator script lives outside the API package; without it there is nothing to cross-check.
      return;
    }
    const plain = randomBytes(70_000);
    const enc = await encrypt(KEY, plain);
    const inPath = join(dir, 'a.zip.enc');
    const outPath = join(dir, 'a.zip');
    await writeFile(inPath, enc);

    await execFileAsync(process.execPath, [script, inPath, outPath], {
      env: { ...process.env, BACKUP_ENC_KEY: KEY.toString('base64') },
    });
    expect((await readFile(outPath)).equals(plain)).toBe(true);
  });

  it('exits non-zero and names the key mismatch with the wrong key', async () => {
    if (!existsSync(script)) return;
    const enc = await encrypt(KEY, randomBytes(100));
    const inPath = join(dir, 'b.zip.enc');
    await writeFile(inPath, enc);
    await expect(
      execFileAsync(process.execPath, [script, inPath, join(dir, 'b.zip')], {
        env: { ...process.env, BACKUP_ENC_KEY: OTHER_KEY.toString('hex') },
      }),
    ).rejects.toMatchObject({ stderr: expect.stringMatching(/does not match/) });
    expect(existsSync(join(dir, 'b.zip'))).toBe(false);
  });
});
