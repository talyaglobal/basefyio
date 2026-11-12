import { NotFoundException } from '@nestjs/common';
import {
  MAX_AVATAR_BYTES,
  avatarLink,
  avatarVersion,
  checkAvatarInput,
  isOwnAvatarLink,
  parseImageDataUrl,
  publicAvatarUrl,
} from './avatar-url.util';
import { AvatarsController } from './avatars.controller';

const PNG_1PX =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const API = 'https://api.example.com';
const USER = '6f1c2f9e-1111-4222-8333-944455556666';

describe('avatar-url.util', () => {
  it('replaces an inline photo with a short, versioned link', () => {
    const url = publicAvatarUrl(USER, PNG_1PX, API)!;
    expect(url).toBe(`${API}/api/avatars/${USER}/${avatarVersion(PNG_1PX)}`);
    expect(url.length).toBeLessThan(120);
  });

  it('leaves http(s) photos and missing photos as they are', () => {
    expect(publicAvatarUrl(USER, 'https://cdn.example.com/a.png', API)).toBe('https://cdn.example.com/a.png');
    expect(publicAvatarUrl(USER, null, API)).toBeNull();
    expect(publicAvatarUrl(USER, '', API)).toBeNull();
  });

  it('changes the link when the photo changes', () => {
    const other = `${PNG_1PX.slice(0, -4)}AAAA`;
    expect(other).not.toBe(PNG_1PX);
    expect(avatarVersion(other)).not.toBe(avatarVersion(PNG_1PX));
  });

  it('decodes image data URLs and rejects everything else', () => {
    const parsed = parseImageDataUrl(PNG_1PX)!;
    expect(parsed.mimeType).toBe('image/png');
    expect(parsed.data.subarray(1, 4).toString('ascii')).toBe('PNG');
    expect(parseImageDataUrl('data:text/html;base64,PGgxPg==')).toBeNull();
    expect(parseImageDataUrl('https://x/y.png')).toBeNull();
  });

  it('recognises its own link so an echoed profile does not overwrite the photo', () => {
    const link = avatarLink(USER, PNG_1PX, API);
    expect(isOwnAvatarLink(USER, link, API)).toBe(true);
    expect(isOwnAvatarLink(USER, `https://app.example.com/api/proxy/avatars/${USER}/abc`, API)).toBe(true);
    expect(isOwnAvatarLink('someone-else', link, API)).toBe(false);
    expect(isOwnAvatarLink(USER, 'https://cdn.example.com/a.png', API)).toBe(false);
  });

  it('validates new photos on save', () => {
    expect(checkAvatarInput('')).toEqual({ ok: true, value: null });
    expect(checkAvatarInput(PNG_1PX)).toEqual({ ok: true, value: PNG_1PX });
    expect(checkAvatarInput('https://cdn.example.com/a.png')).toEqual({
      ok: true,
      value: 'https://cdn.example.com/a.png',
    });
    expect(checkAvatarInput('javascript:alert(1)').ok).toBe(false);
    expect(checkAvatarInput('data:text/html;base64,PGgxPg==').ok).toBe(false);
    const huge = `data:image/png;base64,${Buffer.alloc(MAX_AVATAR_BYTES + 1).toString('base64')}`;
    expect(checkAvatarInput(huge)).toEqual({ ok: false, message: 'Profile photo must be 2 MB or smaller' });
  });
});

describe('AvatarsController', () => {
  function fakeRes() {
    const headers: Record<string, string> = {};
    const res: any = {
      headers,
      statusCode: 0,
      body: undefined as Buffer | undefined,
      setHeader: (k: string, v: string) => { headers[k.toLowerCase()] = v; },
      status(code: number) { this.statusCode = code; return this; },
      end(body: Buffer) { this.body = body; return this; },
    };
    return res;
  }

  function controllerFor(avatarUrl: string | null) {
    const prisma: any = { user: { findUnique: jest.fn().mockResolvedValue(avatarUrl === undefined ? null : { avatarUrl }) } };
    return new AvatarsController(prisma);
  }

  it('serves the decoded image with cross-origin, cache and sandbox headers', async () => {
    const res = fakeRes();
    await controllerFor(PNG_1PX).serve(USER, avatarVersion(PNG_1PX), res);
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('image/png');
    expect(res.headers['cache-control']).toContain('immutable');
    expect(res.headers['cross-origin-resource-policy']).toBe('cross-origin');
    expect(res.headers['content-security-policy']).toContain('sandbox');
    expect(res.body?.subarray(1, 4).toString('ascii')).toBe('PNG');
  });

  it('answers 404 for a stale or guessed version', async () => {
    await expect(controllerFor(PNG_1PX).serve(USER, 'a'.repeat(20), fakeRes())).rejects.toBeInstanceOf(NotFoundException);
    await expect(controllerFor(PNG_1PX).serve(USER, 'not-a-version', fakeRes())).rejects.toBeInstanceOf(NotFoundException);
  });

  it('answers 404 when the user has no inline photo', async () => {
    const link = 'https://cdn.example.com/a.png';
    await expect(controllerFor(link).serve(USER, avatarVersion(link), fakeRes())).rejects.toBeInstanceOf(NotFoundException);
    await expect(controllerFor(null).serve(USER, 'a'.repeat(20), fakeRes())).rejects.toBeInstanceOf(NotFoundException);
  });
});
