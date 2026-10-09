import { hits, cite, fileHas, exists, check, yes, no, part, sources } from './lib.mjs';
import { readFileSync } from 'fs';
import { join } from 'path';
import { ROOT } from './lib.mjs';

const API = ['apps/platform-api/src'];
const SDK = ['packages/sdk/src'];
const CLI = ['packages/cli/src'];
const UI = ['apps/admin-ui/app', 'apps/admin-ui/components', 'apps/admin-ui/lib'];
const COMPOSE = ['docker-compose.prod.yml', 'docker-compose.yml'];

const found = (pattern, roots, exts) => {
  const h = hits(pattern, roots, exts);
  return { h, n: h.length, where: cite(h) };
};

/**
 * Patterns here must match a capability, not an English word.
 *
 * The first version of this file scored Edge functions 51 and Realtime 56 —
 * both wrong, and wrong in our favour. `/LISTEN/i` had matched `app.listen`,
 * `/presence/i` a sentence in a recommendation service, `/isolate/i` the word
 * "isolation" in a comment about tenants. A loose pattern does not report a
 * capability, it reports a coincidence, and the coincidences flatter whoever
 * wrote the regex.
 *
 * So: match identifiers case-sensitively, and look only where the capability
 * would actually live.
 */
const marker = (pattern, roots, exts) => found(pattern, roots, exts);

/**
 * One probe per scoreboard category.
 *
 * Every verdict is derived from the tree and cites where it came from, so the
 * number can be argued with. The weights are the ones the benchmark uses, and
 * `rival` is the score it gives Supabase — kept here only so the gap is
 * visible, never to set our own.
 */
export const CATEGORIES = [
  {
    id: 'security',
    name: 'Security & tenant isolation',
    weight: 12,
    rival: 90,
    checks: [
      check('API keys are bound to their own project', 2, () => {
        const f = marker(/assertKeyMatchesTargetProject/, API);
        return f.n ? yes(f.where) : no('a key could act on any project');
      }),
      check('key-authed SQL runs under a Postgres role, never as owner', 2, () => {
        const role = marker(/SET LOCAL ROLE/, API);
        const noFallback = fileHas('apps/platform-api/src/modules/sql/sql.service.ts', /__setRoleFailed/);
        if (!role.n) return no('no role switch anywhere');
        return noFallback
          ? yes(`${role.where}; owner is not a fallback`)
          : part(0.5, `${role.where}; but a failure may fall back to owner`);
      }),
      check('routes declare how much key authority they need', 2, () => {
        const d = marker(/@ServiceKeyOnly\(\)|@AuthenticatedKeyOnly\(\)/, API);
        return d.n >= 10 ? yes(`${d.n} declarations — ${d.where}`) : part(d.n / 10, d.where);
      }),
      check('the scope check cannot be bypassed by forgetting a guard', 1.5, () => {
        const inGuard = fileHas('apps/platform-api/src/common/guards/api-key.guard.ts', /assertScope/);
        return inGuard
          ? yes('enforced inside ApiKeyGuard itself')
          : no('a separate guard can be left off a controller');
      }),
      check('connection strings are not reachable with the public key', 2, () => {
        const src = join(ROOT, 'apps/platform-api/src/modules/projects/project-data.controller.ts');
        const text = readFileSync(src, 'utf8');
        const classScoped = /@ServiceKeyOnly\(\)/.test(text.slice(0, text.indexOf('export class')));
        return classScoped
          ? yes('ProjectDataController is service-key only')
          : no('GET /connect returns the service key and the database password');
      }),
      check('key-authed requests reach the audit log', 1.5, () => {
        const f = fileHas(
          'apps/platform-api/src/common/interceptors/audit-log.interceptor.ts',
          /resolveApiKeyActor/,
        );
        return f ? yes('audit-log.interceptor.ts records the key and its tier') : no('key traffic leaves no trace');
      }),
      check('SECURITY DEFINER functions cannot be called to escape RLS', 1.5, () => {
        const f = marker(/prosecdef/, API);
        return f.n ? yes(f.where) : no('/rest/v1/rpc never checks prosecdef — a definer function runs as owner');
      }),
      check('the realtime stream goes through the key guard', 1, () => {
        const ok = fileHas(
          'apps/platform-api/src/modules/realtime-data/realtime-data.controller.ts',
          /ApiKeyGuard/,
        );
        return ok ? yes('stream uses ApiKeyGuard') : no('own key lookup; accepts the service key from the query string');
      }),
      check('DDL and policy verbs are denied to non-owner callers', 1, () => {
        const f = marker(/ALTER\s+POLICY|CREATE\s+POLICY|DROP\s+POLICY/i, ['apps/platform-api/src/modules/sql']);
        return f.n ? yes(f.where) : no('the SQL denylist omits DDL and policy statements');
      }),
      check('audit records can be shipped to a SIEM', 1, () => {
        const f = marker(/\bsyslog\b|\bSIEM\b|auditSink|AUDIT_FORWARD/i, API);
        return f.n ? yes(f.where) : no('audit stays in the platform database only');
      }),
      check('the panel can require a second factor', 1, () => {
        const f = marker(/requireMfa|require-mfa/, API);
        return f.n ? part(0.5, `${f.where} — per project user, not for panel sign-in`) : no('no MFA requirement');
      }),
    ],
  },

  {
    id: 'postgres',
    name: 'Postgres database',
    weight: 8,
    rival: 95,
    checks: [
      check('a separate database per project', 2, () => {
        const f = marker(/CREATE DATABASE/, API);
        return f.n ? yes(f.where) : no('shared database');
      }),
      check('pgvector available', 1, () =>
        fileHas('docker/postgres/Dockerfile', /pgvector/) ? yes('docker/postgres/Dockerfile') : no('no vector type')),
      check('PostGIS available', 1, () =>
        fileHas('docker/postgres/Dockerfile', /postgis/i) ? yes('docker/postgres/Dockerfile') : no('no geospatial types')),
      check('extensions created on provisioning', 1, () => {
        const f = marker(/CREATE EXTENSION/, API);
        const text = f.h.map((x) => x.text).join(' ');
        const want = ['pg_trgm', 'vector', 'pgcrypto', 'unaccent', 'btree_gist', 'pg_stat_statements'];
        const have = want.filter((w) => new RegExp(w).test(text));
        return part(have.length / want.length, `created: ${have.join(', ') || 'none'} — ${f.where}`);
      }),
      check('connection pooling in front of Postgres', 1, () => {
        const f = marker(/pgbouncer/i, COMPOSE);
        return f.n ? yes(f.where) : no('direct connections only');
      }),
      check('per-project roles beyond the owner', 1.5, () => {
        const f = marker(/CREATE ROLE/i, API);
        const least = f.h.filter((x) => /migration|readonly|read_only|app_user/i.test(x.text));
        if (!f.n) return no('no roles created beyond the owner');
        return least.length
          ? yes(cite(least))
          : part(0.3, `roles are created (${f.where}) but only anon/authenticated/service, no least-privilege owner split`);
      }),
      check('per-project connection limits', 1, () => {
        const f = marker(/connection_limit|max_client_conn/, API.concat(COMPOSE));
        return f.n ? part(0.5, `${f.where} — a global cap, not per project`) : no('one shared pooler for every project');
      }),
      check('credentials encrypted at rest', 1, () => {
        const f = marker(/DB_CRED_ENC_KEY/, API);
        return f.n ? yes(f.where) : no('passwords stored in clear');
      }),
    ],
  },

  {
    id: 'rest',
    name: 'Auto REST API',
    weight: 10,
    rival: 95,
    checks: [
      check('reads: embedded resources through foreign keys', 2, () =>
        exists('apps/platform-api/src/modules/projects/postgrest/schema-cache.ts')
          ? yes('postgrest/schema-cache.ts resolves relationships')
          : no('no embeds')),
      check('reads: boolean trees (or / and / not)', 1.5, () => {
        const f = marker(/parseLogicChildren|LogicTree/, API);
        return f.n ? yes(f.where) : no('flat filters only');
      }),
      check('reads: full-text search operators', 1, () => {
        const f = marker(/plfts|phfts|to_tsquery/, API);
        return f.n ? yes(f.where) : no('no full-text operators');
      }),
      check('reads: JSON path traversal', 1, () => {
        const f = marker(/jsonPath/, API);
        return f.n ? yes(f.where) : no('no -> / ->> support');
      }),
      check('values are bound, never interpolated into SQL', 2, () => {
        const f = marker(/bind\(/, ['apps/platform-api/src/modules/projects/postgrest']);
        return f.n ? yes(f.where) : no('values written into the statement');
      }),
      check('writes use the same parser as reads', 2, () => {
        const svc = join(ROOT, 'apps/platform-api/src/modules/projects/public-api.service.ts');
        const text = readFileSync(svc, 'utf8');
        // The legacy helper is still what update/delete call.
        const legacy = /parseFilters\(/.test(text);
        return legacy
          ? no('update and delete still use the old flat filter parser — no or/and/not on writes')
          : yes('one parser for reads and writes');
      }),
      check('schemas other than public are reachable', 1, () => {
        const f = marker(/Accept-Profile|Content-Profile/i, API);
        return f.n ? yes(f.where) : no('public schema only');
      }),
      check('rows can be counted exactly alongside a page', 1, () => {
        const f = marker(/buildCount/, API);
        return f.n ? yes(f.where) : no('no count support');
      }),
    ],
  },

  {
    id: 'auth',
    name: 'Authentication',
    weight: 10,
    rival: 92,
    checks: [
      check('email and password sign-in', 1.5, () => {
        const f = marker(/signin|signIn/, ['apps/platform-api/src/modules/projects/project-sdk-auth.controller.ts']);
        return f.n ? yes(f.where) : no('missing');
      }),
      check('social identity providers', 1, () => {
        const f = marker(/saveProvider|signinWithProvider/, API);
        return f.n ? yes(f.where) : no('no social sign-in');
      }),
      check('passwordless sign-in links', 1, () => {
        const f = marker(/magic-link|magicLink/, API);
        return f.n ? yes(f.where) : no('no magic links');
      }),
      check('a second factor the SDK can complete', 2, () => {
        const api = marker(/requireMfa/, API);
        const sdk = marker(/\bmfa\b|\btotp\b/i, SDK);
        if (!api.n) return no('no MFA at all');
        return sdk.n
          ? yes(`${api.where} with an SDK flow`)
          : part(0.4, `admins can require it (${api.where}) but the SDK has no sign-in flow for it`);
      }),
      check('phone or SMS sign-in', 1, () => {
        const f = marker(/\bSMS\b|phone_number|phoneSignIn|signInWithOtp/, API);
        return f.n ? part(0.3, f.where) : no('no phone channel');
      }),
      check('anonymous users that can be upgraded later', 1, () => {
        const f = marker(/anonymousSignIn|signInAnonymously/, API.concat(SDK));
        return f.n ? yes(f.where) : no('not supported');
      }),
      check('SAML for enterprise tenants', 1, () => {
        const f = marker(/\bsaml\b/i, API);
        return f.n ? part(0.3, f.where) : no('not supported');
      }),
      check('an isolated realm per project', 1.5, () => {
        const f = marker(/keycloakRealm/, API);
        return f.n ? yes(f.where) : no('shared user pool');
      }),
      check('end-user tokens are verified, not merely decoded', 2, () => {
        const f = marker(/verifyProjectJwt/, API);
        return f.n ? yes(f.where) : no('claims trusted without a signature check');
      }),
      check('transactional email works without a third-party account', 1, () => {
        const smtp = marker(/nodemailer|createTransport|SMTP_HOST/, API);
        return smtp.n ? yes(smtp.where) : no('Resend only — a self-hosted install cannot send mail');
      }),
    ],
  },

  {
    id: 'storage',
    name: 'Storage',
    weight: 6,
    rival: 88,
    checks: [
      check('buckets, upload, download, signed URLs', 2, () => {
        const f = marker(/getPresignedUrl/, API);
        return f.n ? yes(f.where) : no('missing');
      }),
      check('public and private buckets', 1, () => {
        const f = marker(/updateBucket/, API);
        return f.n ? yes(f.where) : no('no visibility control');
      }),
      check('bucket administration is not reachable with the public key', 1.5, () => {
        const text = readFileSync(join(ROOT, 'apps/platform-api/src/modules/storage/storage.controller.ts'), 'utf8');
        return /@ServiceKeyOnly\(\)/.test(text.slice(0, text.indexOf('export class')))
          ? yes('service-key default on StorageController')
          : no('anyone with the public key can create and drop buckets');
      }),
      check('per-object access policies', 2, () => {
        const f = marker(/StoragePolicy|objectPolicy|storage_policies/, API);
        return f.n ? yes(f.where) : no('access is per bucket; a private object is readable by any key holder');
      }),
      check('resumable uploads for large files', 1, () => {
        const f = marker(/\btus\b|resumable/i, API.concat(SDK));
        return f.n ? yes(f.where) : no('single-request uploads only');
      }),
      check('image transformation on read', 1, () => {
        const f = marker(/sharp|imageTransform|\bresize\(/, API);
        return f.n ? yes(f.where) : no('no transforms');
      }),
      check('the file limit is above a few tens of megabytes', 1, () => {
        const text = readFileSync(join(ROOT, 'apps/platform-api/src/modules/storage/storage.controller.ts'), 'utf8');
        const m = text.match(/MAX_FILE_SIZE\s*=\s*(\d+)\s*\*\s*1024\s*\*\s*1024/);
        const mb = m ? Number(m[1]) : 0;
        return mb >= 500 ? yes(`${mb} MB`) : part(Math.min(mb / 500, 0.9), `${mb} MB ceiling`);
      }),
      check('storage can be pointed at the customer\'s own object store', 1, () => {
        const f = marker(/STORAGE_DRIVER|S3_ENDPOINT/, API);
        return f.n ? yes(f.where) : no('MinIO is wired in directly');
      }),
    ],
  },

  {
    id: 'realtime',
    name: 'Realtime',
    weight: 8,
    rival: 90,
    checks: [
      check('clients can subscribe to changes', 2, () => {
        const f = marker(/text\/event-stream|@Sse\(/, ['apps/platform-api/src/modules/realtime-data']);
        return f.n ? yes(f.where) : no('no subscriptions');
      }),
      check('changes are read from the database log, not only from API writes', 2.5, () => {
        // Twice-narrowed. "LISTEN" matched app.listen; then CREATE PUBLICATION
        // matched sql-guard's denylist — the probe was reading the code that
        // forbids replication as evidence of it. Look only where the capability
        // would be built.
        const f = marker(/wal2json|pgoutput|CREATE PUBLICATION|replication slot|pg_logical/i, [
          'apps/platform-api/src/modules/realtime-data',
        ]);
        return f.n ? yes(f.where) : no('only writes that pass through the API broadcast; direct SQL is invisible');
      }),
      check('row-level policies are applied per subscriber', 2.5, () => {
        const f = found(/realtime.*rls|filterByPolicy/i, API);
        return f.n ? yes(f.where) : no('every subscriber sees every change in the project');
      }),
      check('presence — who else is here', 1, () => {
        const f = marker(/presence/, ['apps/platform-api/src/modules/realtime-data']);
        return f.n ? yes(f.where) : no('not supported');
      }),
      check('broadcast between clients without a database round trip', 1, () => {
        const f = marker(/broadcast/, ['apps/platform-api/src/modules/realtime-data']);
        return f.n ? part(0.4, `${f.where} — server-to-client only, not client-to-client`) : no('not supported');
      }),
      check('more than one server can serve subscriptions', 1.5, () => {
        const RT = ['apps/platform-api/src/modules/realtime-data'];
        const shared = marker(/createAdapter|RedisIoAdapter|redis\.publish|subscribe\(['"`]/, RT);
        // A process-local Map of subscribers is positive evidence of the
        // opposite, and worth citing as such.
        const local = marker(/subscribers\s*=\s*new Map/, RT);
        if (shared.n) return yes(shared.where);
        return no(
          local.n
            ? `subscribers live in a process-local Map — ${local.where}`
            : 'single process holds the subscriptions',
        );
      }),
    ],
  },

  {
    id: 'edge',
    name: 'Edge functions',
    weight: 7,
    rival: 88,
    checks: [
      check('customer code can be deployed and run', 4, () => {
        if (exists('apps/platform-api/src/modules/edge-functions')) return yes('edge-functions module');
        const f = marker(/Deno\.serve|EdgeFunction|isolated-vm|workerd/, API);
        return f.n ? yes(f.where) : no('not built — no runtime for customer code');
      }),
      check('runs sandboxed', 2, () => no('not built')),
      check('triggered by HTTP, schedule and database events', 2, () => {
        const f = marker(/CronExpression|@Cron\(|cronExpression/, ['apps/platform-api/src/modules/flows']);
        return f.n
          ? part(0.3, `flows can run on a schedule, but they run preset actions rather than customer code — ${f.where}`)
          : no('not built');
      }),
      check('logs and metrics per invocation', 1, () => no('not built')),
    ],
  },

  {
    id: 'sdk',
    name: 'SDKs & CLI',
    weight: 7,
    rival: 95,
    checks: [
      check('a JavaScript client', 2, () => (exists('packages/sdk') ? yes('packages/sdk') : no('missing'))),
      check('generated types from the live schema', 1.5, () => {
        const f = marker(/generateTypes|gen-types|genTypes/, CLI);
        return f.n ? yes(f.where) : no('hand-written types only');
      }),
      check('a CLI covering projects, schema and secrets', 1.5, () => {
        const cmds = sources(['packages/cli/src/commands'], ['.ts']).length;
        return cmds >= 10 ? yes(`${cmds} commands`) : part(cmds / 10, `${cmds} commands`);
      }),
      check('the CLI can take a backup and restore one', 1.5, () => {
        const f = marker(/\bbackup\b|\brestore\b/i, CLI);
        return f.n ? yes(f.where) : no('no backup or restore command');
      }),
      check('a Python client', 1, () => (exists('packages/sdk-python') ? yes('present') : no('missing'))),
      check('a Dart or Flutter client', 1, () => (exists('packages/sdk-dart') ? yes('present') : no('missing'))),
      check('a Swift or Kotlin client', 1, () =>
        exists('packages/sdk-swift') || exists('packages/sdk-kotlin') ? yes('present') : no('missing')),
    ],
  },

  {
    id: 'dashboard',
    name: 'Dashboard & developer experience',
    weight: 6,
    rival: 90,
    checks: [
      check('a table editor', 1.5, () => {
        const f = marker(/table-editor|TableEditor/, UI);
        return f.n ? yes(f.where) : no('missing');
      }),
      check('a SQL editor', 1.5, () => {
        const f = marker(/sql-editor|SqlEditor/, UI);
        return f.n ? yes(f.where) : no('missing');
      }),
      check('an API browser with copyable snippets', 1, () => {
        const f = marker(/api-docs|snippet/, ['apps/admin-ui/app/dashboard', 'apps/admin-ui/components']);
        return f.n ? yes(f.where) : no('missing');
      }),
      check('logs visible from the panel', 1, () => {
        const f = marker(/logs/, ['apps/admin-ui/app/dashboard']);
        return f.n ? yes(f.where) : no('missing');
      }),
      check('per-project cost and usage', 1, () => {
        const f = marker(/billing|usage/, ['apps/admin-ui/app/dashboard']);
        return f.n ? yes(f.where) : no('missing');
      }),
      check('a policy editor for row-level security', 1.5, () => {
        const f = marker(/rls|RowLevelSecurity|policies/, ['apps/admin-ui/app/dashboard', 'apps/admin-ui/components']);
        return f.n ? part(0.5, `${f.where} — listed, not edited`) : no('policies must be written as SQL by hand');
      }),
    ],
  },

  {
    id: 'selfhost',
    name: 'Self-hosting & data ownership',
    weight: 6,
    rival: 60,
    checks: [
      check('the whole platform runs from one compose file', 2, () =>
        exists('docker-compose.prod.yml') ? yes('docker-compose.prod.yml') : no('missing')),
      check('many projects on one self-hosted install', 2, () => {
        const f = marker(/keycloakRealm/, API);
        return f.n ? yes('realm per project, so one install serves many') : no('single project only');
      }),
      check('services can be left out of the install', 1.5, () => {
        const f = marker(/profiles:/, COMPOSE);
        return f.n ? yes(f.where) : no('all or nothing — no compose profiles');
      }),
      check('every image is pinned to a version', 1.5, () => {
        const text = readFileSync(join(ROOT, 'docker-compose.prod.yml'), 'utf8');
        const images = [...text.matchAll(/^\s*image:\s*(\S+)/gm)].map((m) => m[1]);
        const latest = images.filter((i) => /:latest$/.test(i) || !/:/.test(i));
        return latest.length === 0
          ? yes(`${images.length} images, all pinned`)
          : part(1 - latest.length / images.length, `${latest.length} of ${images.length} on :latest — ${latest.join(', ')}`);
      }),
      check('an air-gapped install is possible', 1.5, () => {
        const f = marker(/docker save|air.?gap/i, ['docs', 'scripts', '.github']);
        return f.n ? yes(f.where) : no('no offline image bundle');
      }),
      check('images are signed and ship an SBOM', 1, () => {
        const f = marker(/cosign|\bsbom\b|syft/i, ['.github', 'scripts']);
        return f.n ? yes(f.where) : no('neither');
      }),
      check('the customer can bring their own TLS certificate', 1, () => {
        const f = marker(/TLS_CERT|certFile|customCertificates/, COMPOSE.concat(['docker']));
        return f.n ? part(0.4, f.where) : no("Traefik with Let's Encrypt is the only path");
      }),
    ],
  },

  {
    id: 'scale',
    name: 'Scalability & high availability',
    weight: 6,
    rival: 90,
    checks: [
      check('the API runs as more than one replica', 2, () => {
        const f = marker(/replicas:/, COMPOSE);
        return f.n ? yes(f.where) : no('one container');
      }),
      check('a Postgres standby exists', 2.5, () => {
        const f = marker(/hot_standby|primary_conninfo|patroni/i, COMPOSE.concat(API));
        return f.n ? yes(f.where) : no('a single Postgres instance holds every project');
      }),
      check('failover is automatic', 2, () => {
        const f = marker(/patroni|repmgr|pg_auto_failover/i, COMPOSE.concat(['scripts']));
        return f.n ? yes(f.where) : no('manual recovery only');
      }),
      check('read traffic can be sent to a replica', 1, () => {
        const f = marker(/readReplica|read_replica|REPLICA_URL/, API);
        return f.n ? yes(f.where) : no('all reads hit the primary');
      }),
      check('metrics are exported for monitoring', 1.5, () => {
        const f = marker(/prom-client|@Get\('metrics'\)|PrometheusModule/, API);
        return f.n ? yes(f.where) : no('no Prometheus endpoint');
      }),
      check('a health endpoint exists', 1, () => {
        const f = marker(/@Get\(/, ['apps/platform-api/src/modules/health']);
        return f.n ? yes(f.where) : no('missing');
      }),
    ],
  },

  {
    id: 'ops',
    name: 'Backups, branching & operations',
    weight: 4,
    rival: 85,
    checks: [
      check('point-in-time recovery actually works', 2.5, () => {
        const f = marker(/pg_basebackup|recovery_target_time/, ['scripts', 'apps/platform-api/src']);
        return f.n ? yes(f.where) : no('logical dumps only, which cannot anchor a replay');
      }),
      check('backups are automated on a schedule', 1.5, () => {
        const f = marker(/backup/i, ['scripts', '.github/workflows']);
        const scheduled = marker(/cron|schedule:/i, ['.github/workflows', 'scripts']);
        if (!f.n) return no('no backup script at all');
        return scheduled.n ? yes(`${f.where}, scheduled`) : part(0.5, `${f.where} — present but not scheduled`);
      }),
      check('backups are encrypted and kept off the server', 1.5, () => {
        const f = marker(/gpg --encrypt|age -r|BACKUP_S3|offsite/i, ['scripts']);
        return f.n ? yes(f.where) : no('local, unencrypted');
      }),
      check('the platform schema moves by versioned migration', 1.5, () => {
        const pushOnly = marker(/prisma db push/, ['.github', 'docker', 'apps/platform-api/package.json', 'scripts']);
        return pushOnly.n
          ? no(`schema is applied with db push at container start — ${pushOnly.where}`)
          : yes('versioned migrations');
      }),
      check('preview or branch environments per change', 1, () => {
        const f = marker(/previewBranch|preview_branch|branchEnvironment/, API.concat(['.github']));
        return f.n ? yes(f.where) : no('not supported');
      }),
      check('a restore has been exercised end to end', 1, () => {
        const f = marker(/restore/i, ['scripts']);
        return f.n ? part(0.6, `${f.where} — script exists; no automated verification`) : no('untested');
      }),
    ],
  },

  {
    id: 'ai',
    name: 'AI & vector search',
    weight: 3,
    rival: 80,
    checks: [
      check('a vector column type', 1.5, () =>
        fileHas('docker/postgres/Dockerfile', /pgvector/) ? yes('pgvector in the image') : no('missing')),
      check('embeddings can be stored and searched through the API', 1.5, () =>
        exists('apps/platform-api/src/modules/tenant-embedding') ? yes('tenant-embedding module') : no('missing')),
      check('retrieval over the project\'s own documents', 1.5, () =>
        exists('apps/platform-api/src/modules/rag') ? yes('rag module') : no('missing')),
      check('more than one embedding provider', 1, () => {
        const f = marker(/EMBEDDING_PROVIDER|cohere|voyage|OLLAMA/i, [
          'apps/platform-api/src/modules/rag',
          'apps/platform-api/src/modules/tenant-embedding',
        ]);
        return f.n ? yes(f.where) : no('one provider; its key going cold stops retrieval');
      }),
      check('the model and the country data goes to are visible to the customer', 1, () => {
        const f = marker(/dataRegion|data_region|providerDisclosure/, API.concat(UI));
        return f.n ? yes(f.where) : no('not surfaced');
      }),
    ],
  },

  {
    id: 'migration',
    name: 'Migration & onboarding',
    weight: 2,
    rival: 70,
    checks: [
      check('an importer for an existing hosted project', 2, () =>
        exists('apps/platform-api/src/modules/projects/supabase-import.service.ts')
          ? yes('supabase-import.service.ts')
          : no('missing')),
      check('schema, rows, users and files all come across', 2, () => {
        const f = marker(/runStorageSync|importAuthUsers|syncTable/, API);
        return f.n >= 2 ? yes(f.where) : part(f.n / 2, f.where);
      }),
      check('a second pass can fill in what a first run missed', 1.5, () => {
        const f = marker(/runSyncImport/, API);
        return f.n ? yes(f.where) : no('only a full re-import');
      }),
      check('existing client code keeps working after the move', 1.5, () =>
        exists('apps/platform-api/src/modules/projects/postgrest/parser.ts')
          ? yes('PostgREST-compatible query parsing')
          : no('queries must be rewritten')),
      check('an imported table keeps its primary key, so a later sync can match rows', 1.5, () => {
        const f = marker(/PRIMARY KEY/, ['apps/platform-api/src/modules/projects/supabase-import.service.ts']);
        return f.n
          ? yes(f.where)
          : no('tables arrive without keys, so the sync pass cannot match rows and a full re-import is the only repair');
      }),
      check('the import reports a row count per table against the source', 1, () => {
        const f = marker(/sourceRows|expectedRows|rowCountMismatch/, API);
        return f.n ? yes(f.where) : no('counts are reported, but not reconciled against the source');
      }),
    ],
  },

  {
    id: 'tests',
    name: 'Testing & code quality',
    weight: 2,
    rival: 85,
    checks: [
      check('a unit test suite of real size', 2, () => {
        let n = 0;
        for (const f of sources(['apps/platform-api/src'], ['.spec.ts'])) {
          n += (readFileSync(f, 'utf8').match(/\n\s*(it|test)\(/g) ?? []).length;
        }
        return n >= 800 ? yes(`${n} cases`) : part(Math.min(n / 800, 0.95), `${n} cases`);
      }),
      check('the security guards are covered', 1.5, () =>
        exists('apps/platform-api/src/common/guards/api-key.guard.spec.ts')
          ? yes('api-key.guard.spec.ts')
          : no('uncovered')),
      check('a tripwire on what the public key may reach', 1.5, () =>
        exists('apps/platform-api/src/common/guards/api-key-scope.contract.spec.ts')
          ? yes('api-key-scope.contract.spec.ts')
          : no('a deleted decorator would pass unnoticed')),
      check('storage, realtime and auth admin are covered', 1.5, () => {
        const specs = ['modules/storage', 'modules/realtime-data', 'modules/projects/project-auth']
          .map((d) => sources([`apps/platform-api/src/${d}`], ['.spec.ts']).length)
          .filter((n) => n > 0).length;
        return part(specs / 3, `${specs} of 3 areas have a spec`);
      }),
      check('an end-to-end suite exercises the real stack', 1.5, () => {
        const n = sources(['apps/platform-api/test', 'e2e'], ['.ts']).length;
        return n >= 10 ? yes(`${n} files`) : part(Math.min(n / 10, 0.4), `${n} files — smoke level`);
      }),
      check('this scoreboard is measured rather than asserted', 1, () =>
        exists('tools/scoreboard/probes.mjs') ? yes('tools/scoreboard') : no('hand-maintained')),
    ],
  },

  {
    id: 'docs',
    name: 'Docs, community & ecosystem',
    weight: 3,
    rival: 95,
    checks: [
      check('a quickstart a developer can follow alone', 1.5, () =>
        exists('README.md') ? yes('README.md') : no('missing')),
      check('self-hosting documented', 1.5, () => {
        const f = marker(/self.?host/i, ['docs', 'README.md']);
        return f.n ? yes(f.where) : no('missing');
      }),
      check('API reference per module', 1.5, () => {
        const n = sources(['docs'], ['.md']).length;
        return n >= 20 ? yes(`${n} documents`) : part(Math.min(n / 20, 0.8), `${n} documents`);
      }),
      check('installation documented in the customer\'s language', 1, () => {
        const f = marker(/kurulum/i, ['docs']);
        return f.n ? yes(f.where) : no('English only');
      }),
      check('component licences published per release', 1, () => {
        const f = marker(/license-report|licenses\.json|sbom/i, ['.github/workflows', 'scripts']);
        return f.n ? yes(f.where) : no('not published');
      }),
      check('more than one regular contributor', 1.5, () => no('effectively one contributor')),
      check('an example application', 1, () => (exists('examples') ? yes('examples/') : no('none'))),
    ],
  },
];
