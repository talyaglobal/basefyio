import { Controller, Get, NotFoundException, Param, Res } from '@nestjs/common';
import { Response } from 'express';
import { PrismaService } from '../../prisma/prisma.service';
import { avatarVersion, parseImageDataUrl } from './avatar-url.util';

const VERSION_RE = /^[a-f0-9]{20}$/;

/**
 * Serves profile photos stored inline (see avatar-url.util). Public on purpose:
 * an <img> tag cannot send a bearer token, and the version segment — a hash of
 * the stored photo — is only ever revealed by an authenticated response, so a
 * link cannot be guessed. A changed photo gets a new link, which is why the
 * response may be cached for a year.
 */
@Controller('avatars')
export class AvatarsController {
  constructor(private readonly prisma: PrismaService) {}

  @Get(':userId/:version')
  async serve(
    @Param('userId') userId: string,
    @Param('version') version: string,
    @Res() res: Response,
  ) {
    if (!userId || userId.length > 128 || !VERSION_RE.test(version)) {
      throw new NotFoundException('Avatar not found');
    }
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { avatarUrl: true },
    });
    const stored = user?.avatarUrl;
    if (!stored || avatarVersion(stored) !== version) {
      throw new NotFoundException('Avatar not found');
    }
    const image = parseImageDataUrl(stored);
    if (!image) throw new NotFoundException('Avatar not found');

    res.setHeader('Content-Type', image.mimeType);
    res.setHeader('Content-Length', String(image.data.length));
    res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    // The dashboard lives on another origin; helmet's same-origin default would block the <img>.
    res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    // An SVG opened directly must not run script on the API origin.
    res.setHeader('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; sandbox");
    res.status(200).end(image.data);
  }
}
