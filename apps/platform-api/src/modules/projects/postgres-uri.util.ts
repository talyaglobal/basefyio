import { ConfigService } from '@nestjs/config';

/** Percent-encode user/password for postgresql:// URIs. */
export function encPgPart(s: string): string {
  return encodeURIComponent(s);
}

export function buildPostgresUri(
  host: string,
  port: number,
  user: string,
  password: string,
  database: string,
): string {
  return `postgresql://${encPgPart(user)}:${encPgPart(password)}@${host}:${port}/${database}`;
}

export function getPgbouncerClientEndpoints(config: ConfigService): {
  host: string;
  port: number;
} {
  return {
    host: config.get<string>('pgbouncer.externalHost') || 'localhost',
    port: config.get<number>('pgbouncer.externalPort') || 6432,
  };
}

/**
 * Host/port clients should use to reach Postgres directly (migrations, Prisma migrate, hosted vendor CLI).
 * When unset, falls back to the pooler endpoint (same as DATABASE_URL) — still works once DB CREATE is granted.
 */
export function getPostgresDirectClientEndpoints(
  config: ConfigService,
  poolerHost: string,
  poolerPort: number,
): { host: string; port: number } {
  const h = config.get<string>('postgresPublic.directHost')?.trim();
  const p = config.get<number | undefined>('postgresPublic.directPort');
  return {
    host: h || poolerHost,
    port: p != null && !Number.isNaN(p) ? p : poolerPort,
  };
}
