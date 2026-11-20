import { createDecipheriv, pbkdf2Sync } from 'crypto';
import { HttpMinioAdmin, MinioAdminError, encryptAdminPayload, signV4 } from './minio-admin.client';

/** sio-go / madmin DecryptData for the PBKDF2 + AES-GCM variant, written independently of the encoder. */
function decrypt(password: string, data: Buffer): Buffer {
  const salt = data.subarray(0, 32);
  expect(data[32]).toBe(0x02);
  const nonce8 = data.subarray(33, 41);
  const key = pbkdf2Sync(password, salt, 8192, 32, 'sha256');
  const nonce = (seq: number) => Buffer.concat([nonce8, Buffer.from([seq & 0xff, (seq >> 8) & 0xff, 0, 0])]);
  const open = (ct: Buffer, seq: number, ad: Buffer) => {
    const d = createDecipheriv('aes-256-gcm', key, nonce(seq));
    d.setAAD(ad);
    d.setAuthTag(ct.subarray(ct.length - 16));
    return Buffer.concat([d.update(ct.subarray(0, ct.length - 16)), d.final()]);
  };
  // Tag of an empty message under nonce 0 = the associated-data suffix.
  const c = require('crypto').createCipheriv('aes-256-gcm', key, nonce(0));
  c.final();
  const tag: Buffer = c.getAuthTag();
  const body = data.subarray(41);
  const out: Buffer[] = [];
  let off = 0;
  let seq = 1;
  while (body.length - off > 16384 + 16) {
    out.push(open(body.subarray(off, off + 16384 + 16), seq++, Buffer.concat([Buffer.from([0]), tag])));
    off += 16384 + 16;
  }
  out.push(open(body.subarray(off), seq, Buffer.concat([Buffer.from([0x80]), tag])));
  return Buffer.concat(out);
}

describe('MinIO admin client', () => {
  describe('signV4', () => {
    it('matches the AWS SigV4 test suite (get-vanilla)', () => {
      expect(
        signV4({
          method: 'GET',
          path: '/',
          headers: { host: 'example.amazonaws.com', 'x-amz-date': '20150830T123600Z' },
          payloadHash: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
          accessKey: 'AKIDEXAMPLE',
          secretKey: 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY',
          region: 'us-east-1',
          service: 'service',
          amzDate: '20150830T123600Z',
        }),
      ).toBe(
        'AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20150830/us-east-1/service/aws4_request, SignedHeaders=host;x-amz-date, Signature=5fa00fa31553b73ebf1942676e86291e8372ff2a2260956d9b8aae1d763fbf31',
      );
    });

    it('matches minio-go signer.SignV4 for an admin request', () => {
      // Reference produced by github.com/minio/minio-go/v7/pkg/signer for the same request.
      const hash = '52279714d77bcfad953e90e091f01cf2b8df980cb4c43eea600ce15103933a2c';
      expect(
        signV4({
          method: 'PUT',
          path: '/minio/admin/v3/add-canned-policy',
          query: { name: 'bf-s3keys-abc' },
          headers: { host: 'minio:9000', 'x-amz-content-sha256': hash, 'x-amz-date': '20261120T072620Z' },
          payloadHash: hash,
          accessKey: 'rootuser',
          secretKey: 'rootsecret123',
          region: 'us-east-1',
          service: 's3',
          amzDate: '20261120T072620Z',
        }),
      ).toBe(
        'AWS4-HMAC-SHA256 Credential=rootuser/20261120/us-east-1/s3/aws4_request, SignedHeaders=host;x-amz-content-sha256;x-amz-date, Signature=1a3addde4f15d9e13a2441a2893a3554a3743c3708c79d57bc650ead10b72970',
      );
    });
  });

  describe('encryptAdminPayload', () => {
    it('produces the bytes madmin-go DecryptData accepted', () => {
      // Golden vector, decrypted by madmin-go v3 DecryptData("rootsecret123", …) to the payload below.
      let i = 0;
      const rand = (n: number) => Buffer.alloc(n, ++i);
      const out = encryptAdminPayload(
        'rootsecret123',
        Buffer.from('{"policies":["bf-s3keys-p1"],"user":"BFS3ABCDEFGHIJKLMNOP"}'),
        rand,
      );
      expect(out.toString('hex')).toBe(
        '0101010101010101010101010101010101010101010101010101010101010101020202020202020202c2d468e95f8e3c8573ac72d344fc4f2fa2d81f0eaa7172e469d7eea5a8249317ffd2e0ca57e30078e38ff20f16d6eee520161ddc92b81b82f5958e16f27ed90b00b468ae99dda51b5dd6bc',
      );
    });

    it.each([0, 75, 16384, 16384 * 2 + 77])('round-trips %d bytes across fragment boundaries', (size) => {
      const data = Buffer.alloc(size, 0x61);
      const enc = encryptAdminPayload('pw', data);
      expect(decrypt('pw', enc).equals(data)).toBe(true);
      expect(() => decrypt('other', enc)).toThrow();
    });
  });

  describe('HttpMinioAdmin', () => {
    const make = (responses: Array<{ status: number; body?: string }>) => {
      const calls: Array<{ url: string; init: any }> = [];
      const fetchImpl = jest.fn(async (url: string, init: any) => {
        calls.push({ url, init });
        const r = responses.shift() ?? { status: 200 };
        return new Response(r.body ?? '', { status: r.status });
      }) as any;
      const admin = new HttpMinioAdmin({ endpoint: 'http://minio:9000', accessKey: 'root', secretKey: 'rootpw', fetchImpl });
      return { admin, calls };
    };

    it('sends the canned policy as plain JSON, signed', async () => {
      const { admin, calls } = make([{ status: 200 }]);
      await admin.putPolicy('bf-s3keys-p1', { Version: '2012-10-17', Statement: [] });
      expect(calls[0].url).toBe('http://minio:9000/minio/admin/v3/add-canned-policy?name=bf-s3keys-p1');
      expect(calls[0].init.method).toBe('PUT');
      expect(JSON.parse(Buffer.from(calls[0].init.body).toString())).toEqual({ Version: '2012-10-17', Statement: [] });
      expect(calls[0].init.headers.authorization).toMatch(/^AWS4-HMAC-SHA256 Credential=root\//);
    });

    it('encrypts the add-user body with the admin secret and never sends it in clear', async () => {
      const { admin, calls } = make([{ status: 200 }]);
      await admin.addUser('BFS3AAAA', 'the-secret-value');
      const body = Buffer.from(calls[0].init.body);
      expect(body.toString('latin1')).not.toContain('the-secret-value');
      expect(JSON.parse(decrypt('rootpw', body).toString())).toEqual({ secretKey: 'the-secret-value', status: 'enabled' });
      expect(calls[0].url).toBe('http://minio:9000/minio/admin/v3/add-user?accessKey=BFS3AAAA');
    });

    it('attaches through the builtin IDP route', async () => {
      const { admin, calls } = make([{ status: 200 }]);
      await admin.attachPolicy('BFS3AAAA', 'bf-s3keys-p1');
      expect(calls[0].url).toBe('http://minio:9000/minio/admin/v3/idp/builtin/policy/attach');
      expect(calls[0].init.method).toBe('POST');
      expect(JSON.parse(decrypt('rootpw', Buffer.from(calls[0].init.body)).toString())).toEqual({
        policies: ['bf-s3keys-p1'],
        user: 'BFS3AAAA',
      });
    });

    it('treats an already-removed user as removed', async () => {
      const { admin } = make([{ status: 404, body: '{"Code":"XMinioAdminNoSuchUser","Message":"x"}' }]);
      await expect(admin.removeUser('BFS3AAAA')).resolves.toBeUndefined();
    });

    it('reports MinIO error codes without the request', async () => {
      const { admin } = make([{ status: 403, body: '{"Code":"AccessDenied","Message":"Access Denied."}' }]);
      const err = await admin.addUser('BFS3AAAA', 'sekret').catch((e) => e);
      expect(err).toBeInstanceOf(MinioAdminError);
      expect(err.code).toBe('AccessDenied');
      expect(String(err.message)).not.toContain('sekret');
      expect(String(err.message)).not.toContain('rootpw');
    });
  });
});
