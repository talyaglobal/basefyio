import { BadRequestException, Logger } from '@nestjs/common';
import { AuthService, parseInlineImage } from './auth.service';

/** #150: the profile must never carry an inline (data:) avatar again. */
const PNG_1PX =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
const DATA_URL = `data:image/png;base64,${PNG_1PX}`;

function build(storedAvatar: string | null = null) {
  const svc: any = Object.create(AuthService.prototype);
  svc.logger = new Logger('test');
  svc.minioPublicEndpoint = 'storage.example.com';
  svc.minioPublicPort = 443;
  svc.minioPublicSsl = true;
  svc.ensureAvatarBucket = jest.fn(async () => undefined);
  svc.minioClient = { putObject: jest.fn(async () => ({})) };
  svc.prisma = {
    user: {
      findUnique: jest.fn(async () => ({ id: 'u1', email: 'a@b.c', avatarUrl: storedAvatar })),
      update: jest.fn(async ({ data }: any) => ({ id: 'u1', email: 'a@b.c', ...data })),
      updateMany: jest.fn(async () => ({ count: 1 })),
    },
  };
  return svc;
}

describe('AuthService avatars (#150)', () => {
  it('parses an inline image and refuses anything that is not one', () => {
    const img = parseInlineImage(DATA_URL)!;
    expect(img.mimetype).toBe('image/png');
    expect(img.ext).toBe('png');
    expect(img.buffer.length).toBeGreaterThan(20);
    expect(parseInlineImage('data:text/html;base64,PGI+')).toBeNull();
    expect(parseInlineImage('data:image/svg+xml;base64,PHN2Zz4=')).toBeNull();
    expect(parseInlineImage('https://x/y.png')).toBeNull();
  });

  it('stores an inline image sent to the profile in the bucket, not in the row', async () => {
    const svc = build();
    const url = await svc.normaliseAvatarInput('u1', DATA_URL);
    expect(url).toMatch(/^https:\/\/storage\.example\.com\/bf-platform-avatars\/u1\/avatar-\d+\.png$/);
    expect(svc.minioClient.putObject).toHaveBeenCalledTimes(1);
    const [, , , size, meta] = svc.minioClient.putObject.mock.calls[0];
    expect(size).toBe(parseInlineImage(DATA_URL)!.buffer.length);
    expect(meta).toEqual({ 'Content-Type': 'image/png' });
  });

  it('keeps http(s) URLs, clears on empty, rejects other schemes', async () => {
    const svc = build();
    await expect(svc.normaliseAvatarInput('u1', 'https://cdn.example.com/a.png')).resolves.toBe('https://cdn.example.com/a.png');
    await expect(svc.normaliseAvatarInput('u1', '')).resolves.toBeNull();
    await expect(svc.normaliseAvatarInput('u1', 'javascript:alert(1)')).rejects.toBeInstanceOf(BadRequestException);
    await expect(svc.normaliseAvatarInput('u1', 'data:text/html;base64,PGI+')).rejects.toBeInstanceOf(BadRequestException);
  });

  it('moves a stored inline avatar on first read, only if it is still the same value', async () => {
    const svc = build(DATA_URL);
    const url = await svc.moveInlineAvatar('u1', DATA_URL);
    expect(url).toMatch(/^https:\/\/storage\.example\.com\//);
    expect(svc.prisma.user.updateMany).toHaveBeenCalledWith({
      where: { id: 'u1', avatarUrl: DATA_URL },
      data: { avatarUrl: url },
    });
  });

  it('shows no avatar rather than the inline one when storage fails', async () => {
    const svc = build(DATA_URL);
    svc.minioClient.putObject = jest.fn(async () => {
      throw new Error('minio down');
    });
    await expect(svc.moveInlineAvatar('u1', DATA_URL)).resolves.toBeNull();
    expect(svc.prisma.user.updateMany).not.toHaveBeenCalled();
  });
});
