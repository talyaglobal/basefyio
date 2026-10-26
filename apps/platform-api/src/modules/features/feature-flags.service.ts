import { BadRequestException, Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';

/**
 * Runtime feature flags: the dashboard surfaces that stay hidden until the
 * operator switches them on. Each one is a `SystemSetting` row
 * `features.<name>` holding a boolean; unset means the default below. A
 * flip never needs a deploy or a schema change.
 *
 * A flag can also be on for a few people before everyone: the row
 * `features.<name>.users` holds the user ids it is on for. That is how a new
 * surface is tried by the owner, then the team, then switched on for all.
 */
export const FEATURE_FLAGS = {
  /** WP-9: the organization pages, wizard and header switcher (the API facade is always on). */
  organizations_ui: false,
  /** Phase 1 of the simplification: one sidebar, grouped project menu, Connect button, ⌘K. */
  nav_v2: false,
} as const;

export type FeatureFlagName = keyof typeof FEATURE_FLAGS;
export type FeatureFlagValues = Record<FeatureFlagName, boolean>;
export type FeatureFlagUsers = Record<FeatureFlagName, string[]>;

const KEY_PREFIX = 'features.';
const USERS_SUFFIX = '.users';
/** One lookup per process per 30 s; a flip is visible everywhere within that. */
const CACHE_MS = 30_000;

function isFlagName(name: string): name is FeatureFlagName {
  return Object.prototype.hasOwnProperty.call(FEATURE_FLAGS, name);
}

@Injectable()
export class FeatureFlagsService {
  private cache: { at: number; values: FeatureFlagValues; users: FeatureFlagUsers } | null = null;

  constructor(private readonly prisma: PrismaService) {}

  private async load(): Promise<{ values: FeatureFlagValues; users: FeatureFlagUsers }> {
    if (this.cache && Date.now() - this.cache.at < CACHE_MS) return this.cache;
    const values: FeatureFlagValues = { ...FEATURE_FLAGS };
    const users = Object.fromEntries(Object.keys(FEATURE_FLAGS).map((k) => [k, [] as string[]])) as unknown as FeatureFlagUsers;
    const rows = await this.prisma.systemSetting.findMany({ where: { key: { startsWith: KEY_PREFIX } } });
    for (const row of rows) {
      const rest = row.key.slice(KEY_PREFIX.length);
      if (rest.endsWith(USERS_SUFFIX)) {
        const name = rest.slice(0, -USERS_SUFFIX.length);
        if (isFlagName(name) && Array.isArray(row.value)) {
          users[name] = (row.value as unknown[]).filter((v): v is string => typeof v === 'string');
        }
      } else if (isFlagName(rest)) {
        values[rest] = row.value === true;
      }
    }
    this.cache = { at: Date.now(), values, users };
    return this.cache;
  }

  /** The flags as everyone sees them: on for all, or off. */
  async all(): Promise<FeatureFlagValues> {
    return (await this.load()).values;
  }

  /** The flags as one signed-in user sees them: on for all, or on for this user. */
  async forUser(userId: string): Promise<FeatureFlagValues> {
    const { values, users } = await this.load();
    const out = { ...values };
    for (const name of Object.keys(out) as FeatureFlagName[]) {
      if (!out[name] && users[name].includes(userId)) out[name] = true;
    }
    return out;
  }

  async isEnabled(name: FeatureFlagName, userId?: string): Promise<boolean> {
    return userId ? (await this.forUser(userId))[name] : (await this.all())[name];
  }

  /** Root console: flags and who they are on for, before everyone. */
  async management(): Promise<{ flags: FeatureFlagValues; users: FeatureFlagUsers }> {
    const { values, users } = await this.load();
    return { flags: values, users };
  }

  async set(name: string, enabled: boolean): Promise<FeatureFlagValues> {
    if (!isFlagName(name)) throw new BadRequestException(`Unknown feature flag "${name}"`);
    const key = `${KEY_PREFIX}${name}`;
    await this.prisma.systemSetting.upsert({
      where: { key },
      create: { key, value: enabled },
      update: { value: enabled },
    });
    this.cache = null;
    return this.all();
  }

  /** Replace the list of users a flag is on for ahead of everyone. */
  async setUsers(name: string, userIds: string[]): Promise<FeatureFlagUsers> {
    if (!isFlagName(name)) throw new BadRequestException(`Unknown feature flag "${name}"`);
    const ids = Array.from(new Set(userIds.map((s) => String(s).trim()).filter(Boolean))).slice(0, 500);
    const key = `${KEY_PREFIX}${name}${USERS_SUFFIX}`;
    await this.prisma.systemSetting.upsert({
      where: { key },
      create: { key, value: ids },
      update: { value: ids },
    });
    this.cache = null;
    return (await this.load()).users;
  }
}
