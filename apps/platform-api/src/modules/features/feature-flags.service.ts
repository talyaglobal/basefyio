import { BadRequestException, Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';

/**
 * Runtime feature flags: the dashboard surfaces that stay hidden until the
 * operator switches them on. Each one is a `SystemSetting` row
 * `features.<name>` holding a boolean; unset means the default below. A
 * flip never needs a deploy or a schema change.
 */
export const FEATURE_FLAGS = {
  /** WP-9: the organization pages, wizard and header switcher (the API facade is always on). */
  organizations_ui: false,
} as const;

export type FeatureFlagName = keyof typeof FEATURE_FLAGS;
export type FeatureFlagValues = Record<FeatureFlagName, boolean>;

const KEY_PREFIX = 'features.';
/** One lookup per process per 30 s; a flip is visible everywhere within that. */
const CACHE_MS = 30_000;

@Injectable()
export class FeatureFlagsService {
  private cache: { at: number; values: FeatureFlagValues } | null = null;

  constructor(private readonly prisma: PrismaService) {}

  async all(): Promise<FeatureFlagValues> {
    if (this.cache && Date.now() - this.cache.at < CACHE_MS) return this.cache.values;
    const values: FeatureFlagValues = { ...FEATURE_FLAGS };
    const rows = await this.prisma.systemSetting.findMany({ where: { key: { startsWith: KEY_PREFIX } } });
    for (const row of rows) {
      const name = row.key.slice(KEY_PREFIX.length);
      if (name in values) values[name as FeatureFlagName] = row.value === true;
    }
    this.cache = { at: Date.now(), values };
    return values;
  }

  async isEnabled(name: FeatureFlagName): Promise<boolean> {
    return (await this.all())[name];
  }

  async set(name: string, enabled: boolean): Promise<FeatureFlagValues> {
    if (!(name in FEATURE_FLAGS)) throw new BadRequestException(`Unknown feature flag "${name}"`);
    const key = `${KEY_PREFIX}${name}`;
    await this.prisma.systemSetting.upsert({
      where: { key },
      create: { key, value: enabled },
      update: { value: enabled },
    });
    this.cache = null;
    return this.all();
  }
}
