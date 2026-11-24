import { BadRequestException } from '@nestjs/common';
import { TOURS_SEEN_MAX } from './dto/update-tour-preferences.dto';
import { TourPreferencesService, toTourPreferences } from './tour-preferences.service';

jest.mock('../../prisma/prisma.service', () => ({ PrismaService: class {} }));

type Row = { id: string; toursAutoEnabled: boolean; toursSeen: string[] | null };

/**
 * In-memory stand-in for the users table. Each write is applied atomically
 * after a yield, the way Postgres takes the row lock and re-checks the WHERE
 * on the committed row, so concurrent calls really interleave.
 */
function fakePrisma(seed: Row[] = [{ id: 'alice', toursAutoEnabled: true, toursSeen: [] }]) {
  const rows = seed.map((r) => ({ ...r, toursSeen: r.toursSeen ? [...r.toursSeen] : null }));
  const pick = (r: Row, select?: Record<string, boolean>) =>
    select ? Object.fromEntries(Object.keys(select).map((k) => [k, (r as any)[k]])) : { ...r };
  const tick = () => new Promise((resolve) => setImmediate(resolve));
  const writes: unknown[] = [];
  return {
    rows,
    writes,
    user: {
      findUnique: async ({ where, select }: any) => {
        await tick();
        const r = rows.find((x) => x.id === where.id);
        // Prisma reads a NULL list as [].
        return r ? pick({ ...r, toursSeen: r.toursSeen ?? [] }, select) : null;
      },
      updateMany: async ({ where, data }: any) => {
        writes.push(data);
        await tick();
        const hit = rows.filter((r) => r.id === where.id);
        for (const r of hit) {
          if (data.toursAutoEnabled !== undefined) r.toursAutoEnabled = data.toursAutoEnabled;
          if (data.toursSeen !== undefined) {
            if (!data.toursSeen || !Array.isArray(data.toursSeen.set)) throw new Error('unexpected toursSeen write');
            r.toursSeen = [...data.toursSeen.set];
          }
        }
        return { count: hit.length };
      },
    },
    /** `array_append(COALESCE(tours_seen, '{}'), $id) WHERE id = $user AND NOT ($id = ANY(COALESCE(tours_seen, '{}')))` */
    $executeRaw: async (strings: TemplateStringsArray, ...values: unknown[]) => {
      const sql = strings.join('?');
      expect(sql).toMatch(/array_append/);
      expect(sql).toMatch(/NOT \(\?::TEXT = ANY\(COALESCE\("tours_seen"/);
      const [id, userId, guardId] = values as string[];
      expect(guardId).toBe(id);
      writes.push({ append: id });
      await tick();
      const hit = rows.filter((r) => r.id === userId && !(r.toursSeen ?? []).includes(id));
      for (const r of hit) r.toursSeen = [...(r.toursSeen ?? []), id];
      return hit.length;
    },
  };
}

const svc = (p: ReturnType<typeof fakePrisma>) => new TourPreferencesService(p as any);

describe('TourPreferencesService.update', () => {
  it('marks a tour seen', async () => {
    const p = fakePrisma();
    await expect(svc(p).update('alice', { markSeen: ['projects'] })).resolves.toEqual({ autoEnabled: true, seen: ['projects'] });
    expect(p.rows[0].toursSeen).toEqual(['projects']);
  });

  it('is idempotent for the same id, also twice in one request', async () => {
    const p = fakePrisma();
    await svc(p).update('alice', { markSeen: ['projects', 'projects'] });
    await svc(p).update('alice', { markSeen: ['projects'] });
    expect(p.rows[0].toursSeen).toEqual(['projects']);
  });

  it('keeps both ids when two requests mark different tours at once, and never writes the array back', async () => {
    const p = fakePrisma();
    const s = svc(p);
    await Promise.all([
      s.update('alice', { markSeen: ['projects'] }),
      s.update('alice', { markSeen: ['project-sql'] }),
      s.update('alice', { markSeen: ['projects'] }),
    ]);
    expect([...(p.rows[0].toursSeen ?? [])].sort()).toEqual(['project-sql', 'projects']);
    expect(p.writes.every((w: any) => 'append' in w)).toBe(true);
  });

  it('turns automatic tours off and leaves the seen list untouched', async () => {
    const p = fakePrisma([{ id: 'alice', toursAutoEnabled: true, toursSeen: ['shell'] }]);
    await expect(svc(p).update('alice', { autoEnabled: false })).resolves.toEqual({ autoEnabled: false, seen: ['shell'] });
    expect(p.writes).toEqual([{ toursAutoEnabled: false }]);
  });

  it('clears the list first, then applies markSeen from the same request', async () => {
    const p = fakePrisma([{ id: 'alice', toursAutoEnabled: false, toursSeen: ['shell', 'projects'] }]);
    await expect(svc(p).update('alice', { resetSeen: true, autoEnabled: true, markSeen: ['projects'] })).resolves.toEqual({
      autoEnabled: true,
      seen: ['projects'],
    });
  });

  it("leaves another user's row untouched", async () => {
    const p = fakePrisma([
      { id: 'alice', toursAutoEnabled: true, toursSeen: [] },
      { id: 'bob', toursAutoEnabled: true, toursSeen: ['shell'] },
    ]);
    await svc(p).update('alice', { markSeen: ['projects'], autoEnabled: false });
    await svc(p).update('alice', { resetSeen: true });
    expect(p.rows[1]).toEqual({ id: 'bob', toursAutoEnabled: true, toursSeen: ['shell'] });
  });

  it('refuses an unknown user the way getProfile does, without writing', async () => {
    const p = fakePrisma();
    const err = await svc(p).update('nobody', { markSeen: ['projects'] }).catch((e) => e);
    expect(err).toBeInstanceOf(BadRequestException);
    expect(err.message).toBe('User not found');
    expect(p.writes).toEqual([]);
  });

  it('ignores further ids once the soft cap is reached, without an error', async () => {
    const full = Array.from({ length: TOURS_SEEN_MAX }, (_, i) => `t${i}`);
    const p = fakePrisma([{ id: 'alice', toursAutoEnabled: true, toursSeen: full }]);
    const out = await svc(p).update('alice', { markSeen: ['projects'] });
    expect(out.seen).toHaveLength(TOURS_SEEN_MAX);
    expect(out.seen).not.toContain('projects');

    const almost = fakePrisma([{ id: 'alice', toursAutoEnabled: true, toursSeen: full.slice(1) }]);
    const two = await svc(almost).update('alice', { markSeen: ['a', 'b'] });
    expect(two.seen).toHaveLength(TOURS_SEEN_MAX);
    expect(two.seen).toContain('a');
  });

  it('returns the current values for an empty body, without writing', async () => {
    const p = fakePrisma([{ id: 'alice', toursAutoEnabled: false, toursSeen: ['shell'] }]);
    await expect(svc(p).update('alice', {})).resolves.toEqual({ autoEnabled: false, seen: ['shell'] });
    expect(p.writes).toEqual([]);
  });

  it('never writes a null autoEnabled, even if one gets past validation', async () => {
    const p = fakePrisma([{ id: 'alice', toursAutoEnabled: false, toursSeen: ['shell'] }]);
    await expect(svc(p).update('alice', { autoEnabled: null as any, resetSeen: null as any })).resolves.toEqual({
      autoEnabled: false,
      seen: ['shell'],
    });
    expect(p.writes).toEqual([]);
  });

  it('appends to a row whose stored list is NULL', async () => {
    const p = fakePrisma([{ id: 'alice', toursAutoEnabled: true, toursSeen: null }]);
    await expect(svc(p).update('alice', { markSeen: ['projects'] })).resolves.toEqual({ autoEnabled: true, seen: ['projects'] });
  });
});

describe('toTourPreferences', () => {
  it('maps a row, and a null array to []', () => {
    expect(toTourPreferences({ toursAutoEnabled: true, toursSeen: ['shell'] })).toEqual({ autoEnabled: true, seen: ['shell'] });
    expect(toTourPreferences({ toursAutoEnabled: false, toursSeen: null })).toEqual({ autoEnabled: false, seen: [] });
  });
});
