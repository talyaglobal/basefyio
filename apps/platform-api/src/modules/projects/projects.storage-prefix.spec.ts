import { ProjectsService } from './projects.service';
import { physicalPrefix, prefixIsAmbiguous } from '../storage/bucket-names';

/**
 * New projects never get a storage namespace that overlaps another project's (bf-a- vs bf-a-b-)
 * or the platform's: such a slug gets a hyphen-free storagePrefix instead. Existing projects and
 * their buckets are left as they are. Built from the prototype (only prisma is used).
 */

function build(existing: Array<{ slug: string; storagePrefix?: string | null }>) {
  const svc: any = Object.create(ProjectsService.prototype);
  svc.prisma = {
    project: {
      findMany: jest.fn(async () => existing.map((p) => ({ storagePrefix: null, ...p }))),
      findFirst: jest.fn(async ({ where }: any) =>
        existing.find((p) => where.OR.some((c: any) => c.slug === p.slug || c.storagePrefix === p.storagePrefix && p.storagePrefix)) ?? null,
      ),
    },
  };
  return svc;
}

describe('storage prefix of a new project', () => {
  it('keeps the slug when nothing overlaps', async () => {
    const svc = build([{ slug: 'other_aaaaaa' }, { slug: 'acmes' }]);
    await expect(svc.newProjectStoragePrefix('acme_k3j2h1')).resolves.toBeNull();
  });

  it.each([
    ['a shorter legacy slug', [{ slug: 'acme' }]],
    ['a longer existing slug', [{ slug: 'acme_k3j2h1_q9w8e7' }]],
    ['a frozen storagePrefix', [{ slug: 'renamed_zzzzzz', storagePrefix: 'acme' }]],
    ['a deleted project', [{ slug: 'acme_deleted' }, { slug: 'acme' }]],
  ])('picks a hyphen-free prefix when the slug overlaps %s', async (_what, existing) => {
    const svc = build(existing as any);
    const prefix: string = await svc.newProjectStoragePrefix('acme_k3j2h1');
    expect(prefix).toMatch(/^acmek3j2h1[0-9a-f]{8}$/);
    expect(prefixIsAmbiguous(prefix, existing.map((e: any) => e.storagePrefix ?? e.slug))).toBe(false);
  });

  it('keeps a new project out of the platform namespace', async () => {
    const svc = build([]);
    const prefix: string = await svc.newProjectStoragePrefix('platform_k3j2h1');
    expect(prefix).toMatch(/^platformk3j2h1[0-9a-f]{8}$/);
    expect(physicalPrefix('bf-', prefix).startsWith('bf-platform-')).toBe(false);
  });

  it('a rename clash no longer appends "-<hex>" (that sat inside the other project\'s namespace)', async () => {
    const svc = build([{ slug: 'acme' }]);
    const prefix: string = await svc.uniqueStoragePrefix('acme', 'me');
    expect(prefix).toMatch(/^acme[0-9a-f]{6}$/);
  });
});
