import { createCipheriv, createHash, createHmac, pbkdf2Sync, randomBytes } from 'crypto';

/**
 * The few MinIO admin operations S3 access keys need (feedback #225).
 *
 * Behind an interface so the service is tested with a fake: nothing in a unit test talks to a
 * real MinIO. The HTTP implementation below signs with the platform's root credentials and must
 * only ever be pointed at the internal endpoint (`minio:9000`), never the public host.
 */
export interface MinioAdmin {
  /** Create or replace a canned policy. */
  putPolicy(name: string, policy: object): Promise<void>;
  /** Remove a canned policy; a missing one is not an error. */
  removePolicy(name: string): Promise<void>;
  /** Create an enabled IAM user with this secret. */
  addUser(accessKey: string, secretKey: string): Promise<void>;
  /** Attach a canned policy to a user. */
  attachPolicy(accessKey: string, policyName: string): Promise<void>;
  /** Delete the IAM user; a missing one is not an error. Effective on MinIO's next request. */
  removeUser(accessKey: string): Promise<void>;
}

export const MINIO_ADMIN = Symbol('MINIO_ADMIN');

/** An admin call MinIO refused. Carries MinIO's error code, never the request or credentials. */
export class MinioAdminError extends Error {
  constructor(
    readonly operation: string,
    readonly status: number,
    readonly code: string,
  ) {
    super(`MinIO admin ${operation} failed: ${status} ${code}`);
  }
}

// ── SigV4 ────────────────────────────────────────────────────────────────

const sha256Hex = (data: Buffer | string) => createHash('sha256').update(data).digest('hex');
const hmac = (key: Buffer | string, data: string) => createHmac('sha256', key).update(data).digest();

/** RFC 3986 encoding as SigV4 wants it (encodeURIComponent leaves !'()* alone). */
export function uriEncode(value: string): string {
  return encodeURIComponent(value).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}

export interface SignInput {
  method: string;
  /** Absolute path, unencoded segments joined by `/`. */
  path: string;
  query?: Record<string, string>;
  /** Headers to sign (lower-cased names); `host` must be among them. */
  headers: Record<string, string>;
  payloadHash: string;
  accessKey: string;
  secretKey: string;
  region: string;
  service: string;
  /** `YYYYMMDDTHHMMSSZ` */
  amzDate: string;
}

/** AWS Signature Version 4: the Authorization header for a request. */
export function signV4(input: SignInput): string {
  const date = input.amzDate.slice(0, 8);
  const canonicalUri = input.path
    .split('/')
    .map((s) => uriEncode(s))
    .join('/');
  const canonicalQuery = Object.keys(input.query ?? {})
    .sort()
    .map((k) => `${uriEncode(k)}=${uriEncode(input.query![k])}`)
    .join('&');
  const names = Object.keys(input.headers)
    .map((h) => h.toLowerCase())
    .sort();
  const lower: Record<string, string> = {};
  for (const [k, v] of Object.entries(input.headers)) lower[k.toLowerCase()] = String(v).trim().replace(/\s+/g, ' ');
  const canonicalHeaders = names.map((n) => `${n}:${lower[n]}\n`).join('');
  const signedHeaders = names.join(';');
  const canonicalRequest = [
    input.method.toUpperCase(),
    canonicalUri,
    canonicalQuery,
    canonicalHeaders,
    signedHeaders,
    input.payloadHash,
  ].join('\n');
  const scope = `${date}/${input.region}/${input.service}/aws4_request`;
  const stringToSign = ['AWS4-HMAC-SHA256', input.amzDate, scope, sha256Hex(canonicalRequest)].join('\n');
  const kDate = hmac(`AWS4${input.secretKey}`, date);
  const kRegion = hmac(kDate, input.region);
  const kService = hmac(kRegion, input.service);
  const kSigning = hmac(kService, 'aws4_request');
  const signature = createHmac('sha256', kSigning).update(stringToSign).digest('hex');
  return `AWS4-HMAC-SHA256 Credential=${input.accessKey}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
}

export function amzDate(now = new Date()): string {
  return now.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
}

// ── madmin payload encryption ────────────────────────────────────────────

const PBKDF2_AES_GCM = 0x02;
const PBKDF2_ROUNDS = 8192;
const SIO_BUF = 1 << 14;

/**
 * madmin `EncryptData`, PBKDF2 variant: `salt(32) | 0x02 | nonce(8) | sio-go DARE stream`,
 * key = PBKDF2-SHA256(password, salt, 8192, 32), AES-256-GCM over 16 KiB fragments. Fragment n
 * (from 1) uses nonce `nonce || uint32le(n)`; the associated data is a flag byte (0x00, or 0x80 on
 * the final fragment) followed by the GCM tag of an empty message under fragment nonce 0.
 * MinIO decrypts this with madmin `DecryptData` on every build (FIPS or not).
 */
export function encryptAdminPayload(
  password: string,
  data: Buffer,
  rand: (n: number) => Buffer = randomBytes,
): Buffer {
  const salt = rand(32);
  const nonce8 = rand(8);
  const key = pbkdf2Sync(password, salt, PBKDF2_ROUNDS, 32, 'sha256');
  const nonceFor = (seq: number) => {
    const n = Buffer.alloc(12);
    nonce8.copy(n, 0);
    n.writeUInt32LE(seq, 8);
    return n;
  };
  const seal = (plain: Buffer, seq: number, ad: Buffer) => {
    const c = createCipheriv('aes-256-gcm', key, nonceFor(seq));
    c.setAAD(ad);
    return Buffer.concat([c.update(plain), c.final(), c.getAuthTag()]);
  };
  const headerTag = seal(Buffer.alloc(0), 0, Buffer.alloc(0));
  const ad = Buffer.concat([Buffer.from([0x00]), headerTag]);
  const finalAd = Buffer.concat([Buffer.from([0x80]), headerTag]);

  const parts: Buffer[] = [salt, Buffer.from([PBKDF2_AES_GCM]), nonce8];
  let offset = 0;
  let seq = 1;
  while (data.length - offset > SIO_BUF) {
    parts.push(seal(data.subarray(offset, offset + SIO_BUF), seq++, ad));
    offset += SIO_BUF;
  }
  parts.push(seal(data.subarray(offset), seq, finalAd));
  return Buffer.concat(parts);
}

// ── HTTP client ──────────────────────────────────────────────────────────

export interface HttpMinioAdminOptions {
  /** `http://minio:9000` — the internal endpoint. */
  endpoint: string;
  accessKey: string;
  secretKey: string;
  region?: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

const NOT_FOUND_CODES = new Set(['XMinioAdminNoSuchUser', 'XMinioAdminNoSuchPolicy', 'XMinioAdminNoSuchUserOrGroup']);

export class HttpMinioAdmin implements MinioAdmin {
  private readonly base: URL;
  private readonly region: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly opts: HttpMinioAdminOptions) {
    this.base = new URL(opts.endpoint);
    this.region = opts.region || 'us-east-1';
    this.timeoutMs = opts.timeoutMs ?? 15_000;
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  async putPolicy(name: string, policy: object): Promise<void> {
    await this.call('add-canned-policy', 'PUT', 'add-canned-policy', { name }, Buffer.from(JSON.stringify(policy)));
  }

  async removePolicy(name: string): Promise<void> {
    await this.call('remove-canned-policy', 'DELETE', 'remove-canned-policy', { name }, undefined, true);
  }

  async addUser(accessKey: string, secretKey: string): Promise<void> {
    const body = this.encrypt({ secretKey, status: 'enabled' });
    await this.call('add-user', 'PUT', 'add-user', { accessKey }, body);
  }

  async attachPolicy(accessKey: string, policyName: string): Promise<void> {
    const body = this.encrypt({ policies: [policyName], user: accessKey });
    await this.call('attach-policy', 'POST', 'idp/builtin/policy/attach', {}, body);
  }

  async removeUser(accessKey: string): Promise<void> {
    await this.call('remove-user', 'DELETE', 'remove-user', { accessKey }, undefined, true);
  }

  private encrypt(payload: object): Buffer {
    return encryptAdminPayload(this.opts.secretKey, Buffer.from(JSON.stringify(payload)));
  }

  private async call(
    operation: string,
    method: string,
    relPath: string,
    query: Record<string, string>,
    body?: Buffer,
    missingOk = false,
  ): Promise<void> {
    const payload = body ?? Buffer.alloc(0);
    const path = `/minio/admin/v3/${relPath}`;
    const headers: Record<string, string> = {
      host: this.base.host,
      'x-amz-content-sha256': sha256Hex(payload),
      'x-amz-date': amzDate(),
    };
    const authorization = signV4({
      method,
      path,
      query,
      headers,
      payloadHash: headers['x-amz-content-sha256'],
      accessKey: this.opts.accessKey,
      secretKey: this.opts.secretKey,
      region: this.region,
      service: 's3',
      amzDate: headers['x-amz-date'],
    });
    const qs = Object.keys(query)
      .sort()
      .map((k) => `${uriEncode(k)}=${uriEncode(query[k])}`)
      .join('&');
    const url = `${this.base.protocol}//${this.base.host}${path}${qs ? `?${qs}` : ''}`;
    let res: Response;
    try {
      res = await this.fetchImpl(url, {
        method,
        headers: {
          'x-amz-content-sha256': headers['x-amz-content-sha256'],
          'x-amz-date': headers['x-amz-date'],
          authorization,
          ...(body ? { 'content-type': 'application/octet-stream' } : {}),
        },
        body: body && body.length ? new Uint8Array(body) : undefined,
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (err: any) {
      throw new MinioAdminError(operation, 0, err?.name === 'TimeoutError' ? 'Timeout' : 'Unreachable');
    }
    if (res.ok) {
      await res.arrayBuffer().catch(() => undefined);
      return;
    }
    const text = await res.text().catch(() => '');
    let code = `HTTP${res.status}`;
    try {
      const parsed = JSON.parse(text);
      if (typeof parsed?.Code === 'string') code = parsed.Code;
    } catch {
      const m = /<Code>([^<]+)<\/Code>/.exec(text);
      if (m) code = m[1];
    }
    if (missingOk && (res.status === 404 || NOT_FOUND_CODES.has(code))) return;
    throw new MinioAdminError(operation, res.status, code);
  }
}
