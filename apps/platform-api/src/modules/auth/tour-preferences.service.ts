import { BadRequestException, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { TOURS_SEEN_MAX, UpdateTourPreferencesDto } from './dto/update-tour-preferences.dto';

export interface TourPreferences {
  autoEnabled: boolean;
  seen: string[];
}

/** Maps a users row to the `tours` object of the profile and the PATCH response. */
export function toTourPreferences(u: { toursAutoEnabled: boolean; toursSeen: string[] | null }): TourPreferences {
  return { autoEnabled: u.toursAutoEnabled, seen: u.toursSeen ?? [] };
}

/**
 * Per-user guided-tour preferences. Prisma only: no Keycloak call, so a save
 * is cheap and never touches the session.
 */
@Injectable()
export class TourPreferencesService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Applies, in order: autoEnabled, resetSeen, markSeen. The seen list is never
   * written back whole except on reset; each mark is one conditional append
   * (`array_append ... WHERE NOT (id = ANY(tours_seen))`; Postgres re-checks the
   * WHERE on the locked row), so two tabs marking different tours
   * both land and the same id lands once. An empty body returns current values.
   */
  async update(userId: string, dto: UpdateTourPreferencesDto): Promise<TourPreferences> {
    const current = await this.prisma.user.findUnique({ where: { id: userId }, select: { toursSeen: true } });
    if (!current) throw new BadRequestException('User not found');

    const data: Prisma.UserUpdateManyMutationInput = {};
    if (typeof dto.autoEnabled === 'boolean') data.toursAutoEnabled = dto.autoEnabled;
    if (dto.resetSeen === true) data.toursSeen = { set: [] };
    if (Object.keys(data).length) await this.prisma.user.updateMany({ where: { id: userId }, data });

    const base = dto.resetSeen === true ? [] : current.toursSeen ?? [];
    // Soft cap: a race can pass it by at most one batch; extra ids are dropped
    // silently so the client queue still drains.
    const room = Math.max(0, TOURS_SEEN_MAX - base.length);
    const ids = [...new Set(dto.markSeen ?? [])].filter((id) => !base.includes(id)).slice(0, room);
    for (const id of ids) {
      // Raw on purpose: Prisma's `NOT { has }` filter is NULL on a NULL array,
      // so `push` would silently skip such a row. COALESCE treats NULL as empty.
      await this.prisma.$executeRaw`
        UPDATE "users"
        SET "tours_seen" = array_append(COALESCE("tours_seen", ARRAY[]::TEXT[]), ${id}::TEXT)
        WHERE "id" = ${userId}
          AND NOT (${id}::TEXT = ANY(COALESCE("tours_seen", ARRAY[]::TEXT[])))`;
    }

    const row = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { toursAutoEnabled: true, toursSeen: true },
    });
    if (!row) throw new BadRequestException('User not found');
    return toTourPreferences(row);
  }
}
