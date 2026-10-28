import {
  buildStoragePolicyStatements,
  castAuthUid,
  createRoleIfAbsentSql,
  destBucketParams,
  destObjectParams,
  extraRolesIn,
  logicalBucketName,
  ownerMetaFor,
  parsePolicyRoles,
} from './supabase-storage-catalog';

describe('castAuthUid', () => {
  it('casts bare auth.uid() calls and leaves cast ones, and look-alikes, alone', () => {
    expect(castAuthUid('owner = auth.uid()')).toBe('owner = (auth.uid())::uuid');
    expect(castAuthUid("(storage.foldername(name))[1] = (auth.uid())::text AND auth.uid() IS NOT NULL")).toBe(
      "(storage.foldername(name))[1] = ((auth.uid())::uuid)::text AND (auth.uid())::uuid IS NOT NULL",
    );
    expect(castAuthUid('owner = (auth.uid())::uuid')).toBe('owner = (auth.uid())::uuid');
    expect(castAuthUid('owner = myauth.uid()')).toBe('owner = myauth.uid()');
  });
});

describe('buildStoragePolicyStatements', () => {
  const rows = [
    { tablename: 'objects', policyname: 'Avatars are public', permissive: 'PERMISSIVE', roles: ['public'], cmd: 'SELECT', qual: "bucket_id = 'avatars'", with_check: null },
    { tablename: 'objects', policyname: 'Own uploads', permissive: 'PERMISSIVE', roles: '{authenticated}', cmd: 'INSERT', qual: null, with_check: 'owner = auth.uid()' },
    { tablename: 'objects', policyname: 'Own edits', permissive: 'RESTRICTIVE', roles: ['authenticated', 'service_role'], cmd: 'UPDATE', qual: 'owner = auth.uid()', with_check: 'owner = auth.uid()' },
    { tablename: 'buckets', policyname: 'Everyone sees buckets', permissive: 'PERMISSIVE', roles: [], cmd: 'ALL', qual: 'true', with_check: 'true' },
    { tablename: 'migrations', policyname: 'skip me', permissive: 'PERMISSIVE', roles: ['public'], cmd: 'SELECT', qual: 'true', with_check: null },
  ];

  it('rebuilds each policy with a preceding DROP, casting auth.uid() when the destination returns text', () => {
    const out = buildStoragePolicyStatements(rows, { castAuthUid: true });
    expect(out.map((s) => s.name)).toEqual(['Avatars are public', 'Own uploads', 'Own edits', 'Everyone sees buckets']);
    expect(out[0].drop).toBe('DROP POLICY IF EXISTS "Avatars are public" ON storage."objects"');
    expect(out[0].create).toBe(`CREATE POLICY "Avatars are public" ON storage."objects" AS PERMISSIVE FOR SELECT TO public USING (bucket_id = 'avatars')`);
    expect(out[1].create).toBe('CREATE POLICY "Own uploads" ON storage."objects" AS PERMISSIVE FOR INSERT TO "authenticated" WITH CHECK (owner = (auth.uid())::uuid)');
    expect(out[2].create).toBe(
      'CREATE POLICY "Own edits" ON storage."objects" AS RESTRICTIVE FOR UPDATE TO "authenticated", "service_role" USING (owner = (auth.uid())::uuid) WITH CHECK (owner = (auth.uid())::uuid)',
    );
    expect(out[3].create).toBe('CREATE POLICY "Everyone sees buckets" ON storage."buckets" AS PERMISSIVE FOR ALL TO public USING (true) WITH CHECK (true)');
  });

  it('leaves expressions as they are when the destination already returns uuid', () => {
    const out = buildStoragePolicyStatements(rows.slice(1, 2), { castAuthUid: false });
    expect(out[0].create).toContain('WITH CHECK (owner = auth.uid())');
  });

  it('escapes quotes in names and drops the clauses a command cannot carry', () => {
    const out = buildStoragePolicyStatements(
      [{ tablename: 'objects', policyname: 'say "hi"', permissive: null, roles: null, cmd: 'DELETE', qual: 'true', with_check: 'true' }],
      { castAuthUid: false },
    );
    expect(out[0].create).toBe('CREATE POLICY "say ""hi""" ON storage."objects" AS PERMISSIVE FOR DELETE TO public USING (true)');
  });
});

describe('rows and roles', () => {
  it('parsePolicyRoles reads arrays and raw Postgres array text', () => {
    expect(parsePolicyRoles(['anon', 'authenticated'])).toEqual(['anon', 'authenticated']);
    expect(parsePolicyRoles('{anon,"service_role"}')).toEqual(['anon', 'service_role']);
    expect(parsePolicyRoles(null)).toEqual([]);
  });

  it('extraRolesIn names only roles the bootstrap does not create', () => {
    expect(extraRolesIn([{ tablename: 'objects', policyname: 'p', permissive: null, roles: ['anon', 'authenticator', 'dashboard_user'], cmd: null, qual: null, with_check: null }])).toEqual([
      'authenticator',
      'dashboard_user',
    ]);
    expect(createRoleIfAbsentSql('authenticator')).toContain('create role "authenticator" nologin');
  });

  it('bucket and object rows map onto the destination columns with the logical bucket name', () => {
    const bucket = { id: 'avatars-id', name: 'avatars', public: true, owner: null, owner_id: null, file_size_limit: '1024', allowed_mime_types: ['image/*'], created_at: '2026-01-01T00:00:00Z', updated_at: null };
    expect(logicalBucketName(bucket)).toBe('avatars');
    expect(destBucketParams(bucket)).toEqual(['avatars', 'avatars', true, 1024, ['image/*'], null, null, new Date('2026-01-01T00:00:00Z'), null]);

    const uuid = '7f2c9a4e-1b3d-4c5e-8f6a-0a1b2c3d4e5f';
    const object = {
      id: 'obj-1',
      bucket_id: 'avatars-id',
      name: 'u/1.png',
      owner: uuid,
      owner_id: null,
      metadata: { size: 1 },
      user_metadata: null,
      version: 'v1',
      created_at: new Date('2026-01-02T00:00:00Z'),
      updated_at: 'not a date',
      last_accessed_at: null,
    };
    expect(destObjectParams(object, new Map([['avatars-id', 'avatars']]))).toEqual([
      'obj-1',
      'avatars',
      'u/1.png',
      uuid,
      uuid,
      '{"size":1}',
      null,
      'v1',
      new Date('2026-01-02T00:00:00Z'),
      null,
      null,
    ]);
    expect(ownerMetaFor(object)).toEqual({ 'x-amz-meta-owner': uuid });
    expect(ownerMetaFor({ owner: null, owner_id: 'alice' })).toEqual({ 'x-amz-meta-owner': 'alice' });
    expect(ownerMetaFor(undefined)).toEqual({});
  });
});
