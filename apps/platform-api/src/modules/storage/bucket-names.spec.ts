import { readdirSync, readFileSync, statSync } from 'fs';
import { join, relative } from 'path';
import {
  PLATFORM_BUCKETS,
  classifyBucket,
  inOtherNamespace,
  isPlatformBucket,
  physicalBucketName,
  physicalPrefix,
  prefixIsAmbiguous,
  prefixesOverlap,
} from './bucket-names';

/**
 * The rules behind StorageService.ownedBucket, and a guard that keeps every physical bucket
 * name inside bucket-names.ts (the separator `-` is ambiguous: bf-a- + b-x = bf-a-b- + x).
 */

const A = { id: 'a', physicalPrefix: physicalPrefix('bf-', 'a') };
const AB = { id: 'ab', physicalPrefix: physicalPrefix('bf-', 'a-b') };
const ALL = [A, AB];

describe('physical names', () => {
  it('the separator is ambiguous: two projects build the same physical name', () => {
    expect(physicalBucketName('bf-', 'a', 'b-x')).toBe('bf-a-b-x');
    expect(physicalBucketName('bf-', 'a-b', 'x')).toBe('bf-a-b-x');
  });

  it('sanitises the slug (underscores become hyphens) and lower-cases', () => {
    expect(physicalBucketName('bf-', 'Acme_K3j2h1', 'Docs')).toBe('bf-acme-k3j2h1-docs');
    expect(physicalPrefix('bf-', 'acme_k3j2h1')).toBe('bf-acme-k3j2h1-');
  });

  it('prefixes overlap only at a whole namespace', () => {
    expect(prefixesOverlap('bf-a-', 'bf-a-b-')).toBe(true);
    expect(prefixesOverlap('bf-a-', 'bf-ab-')).toBe(false);
  });
});

describe('classifyBucket', () => {
  const base = { bucketPrefix: 'bf-' };

  it('a recorded owner decides, whatever the name looks like', () => {
    expect(classifyBucket({ ...base, physical: 'bf-a-b-x', project: A, recordedOwner: 'a' })).toEqual({ kind: 'owned', record: false });
    expect(classifyBucket({ ...base, physical: 'bf-a-b-x', project: A, recordedOwner: 'ab' })).toEqual({ kind: 'foreign', ownerId: 'ab' });
    expect(classifyBucket({ ...base, physical: 'bf-a-b-x', project: AB, recordedOwner: 'a' })).toEqual({ kind: 'foreign', ownerId: 'a' });
  });

  it('an unrecorded bucket only one project prefix matches is that project\'s (and gets recorded)', () => {
    expect(classifyBucket({ ...base, physical: 'bf-a-docs', project: A, allProjects: ALL })).toEqual({ kind: 'owned', record: true });
  });

  it('an unrecorded bucket two project prefixes match is refused to both', () => {
    expect(classifyBucket({ ...base, physical: 'bf-a-b-x', project: A, allProjects: ALL }).kind).toBe('ambiguous');
    expect(classifyBucket({ ...base, physical: 'bf-a-b-x', project: AB, allProjects: ALL }).kind).toBe('ambiguous');
  });

  it('a deleted project still counts in the ambiguity check (callers pass projects of any status)', () => {
    const deleted = { id: 'old', physicalPrefix: 'bf-a-b-' };
    expect(classifyBucket({ ...base, physical: 'bf-a-b-x', project: A, allProjects: [A, deleted] }).kind).toBe('ambiguous');
  });

  it('platform buckets are never a project\'s, recorded or not', () => {
    const platformish = { id: 'p', physicalPrefix: 'bf-platform-' };
    for (const b of PLATFORM_BUCKETS) {
      expect(classifyBucket({ ...base, physical: b, project: platformish, recordedOwner: 'p' })).toEqual({ kind: 'platform' });
      expect(classifyBucket({ ...base, physical: b, project: platformish, allProjects: [platformish] })).toEqual({ kind: 'platform' });
    }
    // A legacy project `platform_data` builds bf-platform-data-imports: still refused.
    const pd = { id: 'pd', physicalPrefix: physicalPrefix('bf-', 'platform_data') };
    expect(classifyBucket({ ...base, physical: 'bf-platform-data-imports', project: pd, allProjects: [pd] }).kind).toBe('platform');
    // ... but its own other buckets are fine, and so are a suffixed `platform_k3j2h1`'s.
    expect(classifyBucket({ ...base, physical: 'bf-platform-data-docs', project: pd, allProjects: [pd] }).kind).toBe('owned');
    const pk = { id: 'pk', physicalPrefix: physicalPrefix('bf-', 'platform_k3j2h1') };
    expect(classifyBucket({ ...base, physical: 'bf-platform-k3j2h1-docs', project: pk, allProjects: [pk] }).kind).toBe('owned');
    // A project whose prefix is the bare platform namespace reaches nothing in it.
    expect(isPlatformBucket('bf-platform-anything', 'bf-platform-', 'bf-')).toBe(true);
  });
});

describe('inOtherNamespace (create)', () => {
  it('refuses a name that lands in a longer prefix of another project', () => {
    expect(inOtherNamespace('bf-a-b-x', A, ALL)).toBe(true);
  });
  it('lets the longer-prefix project create its own names (the record then settles ownership)', () => {
    expect(inOtherNamespace('bf-a-b-x', AB, ALL)).toBe(false);
  });
});

describe('prefixIsAmbiguous (new projects)', () => {
  it('flags a slug that extends or is extended by another project\'s prefix', () => {
    expect(prefixIsAmbiguous('acme_k3j2h1', ['acme'])).toBe(true);
    expect(prefixIsAmbiguous('acme', ['acme_k3j2h1'])).toBe(true);
    expect(prefixIsAmbiguous('acme_k3j2h1', ['acme_k3j2h1'])).toBe(true);
  });
  it('flags the platform namespace', () => {
    expect(prefixIsAmbiguous('platform_k3j2h1', [])).toBe(true);
    expect(prefixIsAmbiguous('platform', [])).toBe(true);
  });
  it('passes a prefix with no overlap', () => {
    expect(prefixIsAmbiguous('acme_k3j2h1', ['acmes', 'acme2_x', 'other'])).toBe(false);
    expect(prefixIsAmbiguous('acmek3j2h1ab', ['acme'])).toBe(false);
  });
});

// ── Guard: nobody builds a bucket name outside bucket-names.ts ──────────────

const SRC = join(__dirname, '..', '..');

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...sourceFiles(full));
    else if (full.endsWith('.ts') && !full.endsWith('.spec.ts') && !full.endsWith('.d.ts')) out.push(full);
  }
  return out;
}

/** `bf-…` identifiers that are not buckets (Keycloak realm, MinIO access key of a dedicated store). */
const NOT_BUCKETS: Array<[file: string, snippet: string]> = [
  ['modules/projects/projects.service.ts', 'const realmName = `bf-${slug}`'],
  ['modules/infrastructure/infrastructure.service.ts', 'const accessKey = `bf-${opts.teamSlug}`'],
];

describe('bucket name guard', () => {
  const files = sourceFiles(SRC).map((f) => ({ rel: relative(SRC, f).split('\\').join('/'), text: readFileSync(f, 'utf8') }));

  it('scans the platform-api sources', () => {
    expect(files.some((f) => f.rel === 'modules/storage/storage.service.ts')).toBe(true);
  });

  it('no code outside bucket-names.ts builds a bf-… name or prefix by hand', () => {
    const offenders: string[] = [];
    const patterns = [/`bf-\$\{/g, /['"]bf-['"]\s*\+/g, /bucketPrefix\}/g, /\$\{[^}]*bucketPrefix[^}]*\}[^`]*-/g];
    for (const f of files) {
      if (f.rel === 'modules/storage/bucket-names.ts') continue;
      f.text.split('\n').forEach((line, i) => {
        if (!patterns.some((p) => (p.lastIndex = 0, p.test(line)))) return;
        if (NOT_BUCKETS.some(([file, snippet]) => file === f.rel && line.includes(snippet))) return;
        offenders.push(`${f.rel}:${i + 1}: ${line.trim()}`);
      });
    }
    expect(offenders).toEqual([]);
  });

  it('every platform bucket named in the code is in PLATFORM_BUCKETS', () => {
    const named = new Set<string>();
    for (const f of files) {
      for (const m of f.text.matchAll(/['"`](bf-platform-[a-z0-9-]*)/g)) named.add(m[1]);
    }
    const missing = [...named].filter((n) => n !== 'bf-platform-' && !PLATFORM_BUCKETS.includes(n));
    expect(missing).toEqual([]);
    expect(named.size).toBeGreaterThan(0);
  });

  it('only StorageService turns a project into a physical bucket name', () => {
    const offenders = files
      .filter((f) => f.rel !== 'modules/storage/storage.service.ts' && f.rel !== 'modules/storage/bucket-names.ts')
      .filter((f) => /\bphysicalBucketName\s*\(|\bminioBucketName\s*\(/.test(f.text))
      .map((f) => f.rel);
    expect(offenders).toEqual([]);
  });
});
