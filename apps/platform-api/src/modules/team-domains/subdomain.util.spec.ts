import {
  RESERVED_SUBDOMAINS,
  classifyHost,
  hostWithoutPort,
  normalizeSubdomain,
  resolveBaseDomain,
  validateSubdomain,
  workspaceApiUrl,
  workspaceHost,
} from './subdomain.util';

describe('validateSubdomain', () => {
  it.each(['technoplatz', 'acme-corp', 'a1b', 'team42', 'x'.repeat(63)])('accepts %s', (name) => {
    expect(validateSubdomain(name)).toEqual({ ok: true, value: name });
  });

  it('stores what was typed trimmed and lower-cased', () => {
    expect(validateSubdomain('  TechnoPlatz ')).toEqual({ ok: true, value: 'technoplatz' });
    expect(normalizeSubdomain(undefined)).toBe('');
  });

  it.each([
    ['', 'empty'],
    ['   ', 'empty'],
    ['ab', 'too_short'],
    ['x'.repeat(64), 'too_long'],
    ['acme_corp', 'invalid_characters'],
    ['acme.corp', 'invalid_characters'],
    ['acmé', 'invalid_characters'],
    ['acme corp', 'invalid_characters'],
    ['1acme', 'must_start_with_letter'],
    ['-acme', 'must_start_with_letter'],
    ['acme-', 'hyphen_edge'],
    ['acme--corp', 'double_hyphen'],
    ['xn--80ak6aa92e', 'double_hyphen'],
  ])('refuses %j as %s', (name, code) => {
    const r = validateSubdomain(name);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.code).toBe(code);
      expect(r.message).toMatch(/\w/);
    }
  });

  it('refuses a non-string', () => {
    expect(validateSubdomain(42 as unknown as string)).toMatchObject({ ok: false, code: 'empty' });
  });

  it.each(['app', 'api', 'www', 'storage', 'admin', 'console', 'mail', 'auth', 'traefik', 'minio-console'])(
    'refuses the reserved name %s',
    (name) => {
      expect(validateSubdomain(name)).toMatchObject({ ok: false, code: 'reserved' });
    },
  );

  it('refuses db (too short before it is even looked up as reserved)', () => {
    expect(validateSubdomain('db').ok).toBe(false);
    expect(RESERVED_SUBDOMAINS.has('db')).toBe(true);
  });

  it('refuses names that pass for the platform itself', () => {
    expect(validateSubdomain('basefyio-support')).toMatchObject({ ok: false, code: 'reserved' });
    expect(validateSubdomain('mykolaybase')).toMatchObject({ ok: false, code: 'reserved' });
  });

  it('keeps every reserved name DNS-shaped, so the list cannot hide a typo', () => {
    for (const name of RESERVED_SUBDOMAINS) {
      expect(name).toMatch(/^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/);
    }
  });
});

describe('resolveBaseDomain', () => {
  it('prefers the explicit setting, cleaned', () => {
    expect(resolveBaseDomain(' .Example.COM. ', 'https://api.basefyio.com')).toBe('example.com');
  });

  it('refuses an explicit value that is not a domain', () => {
    expect(resolveBaseDomain('localhost', null)).toBeNull();
    expect(resolveBaseDomain('not a domain', null)).toBeNull();
  });

  it('derives the parent of api.<domain> from the public API URL', () => {
    expect(resolveBaseDomain(undefined, 'https://api.basefyio.com')).toBe('basefyio.com');
    expect(resolveBaseDomain('', 'https://api.eu.example.co.uk/')).toBe('eu.example.co.uk');
  });

  it('derives nothing from a host that is not api.<domain>', () => {
    expect(resolveBaseDomain(undefined, 'http://localhost:4000')).toBeNull();
    expect(resolveBaseDomain(undefined, 'http://127.0.0.1:4000')).toBeNull();
    expect(resolveBaseDomain(undefined, 'https://backend.example.com')).toBeNull();
    expect(resolveBaseDomain(undefined, 'https://api.com')).toBeNull();
    expect(resolveBaseDomain(undefined, 'not a url')).toBeNull();
    expect(resolveBaseDomain(undefined, undefined)).toBeNull();
  });
});

describe('hostWithoutPort', () => {
  it.each([
    ['Technoplatz.Basefyio.com', 'technoplatz.basefyio.com'],
    ['technoplatz.basefyio.com:443', 'technoplatz.basefyio.com'],
    ['technoplatz.basefyio.com.', 'technoplatz.basefyio.com'],
    ['[::1]:4000', '::1'],
    ['::1', '::1'],
    ['', ''],
  ])('%j → %j', (input, expected) => {
    expect(hostWithoutPort(input)).toBe(expected);
  });

  it('copes with a missing header', () => {
    expect(hostWithoutPort(undefined)).toBe('');
    expect(hostWithoutPort(null)).toBe('');
  });
});

describe('classifyHost', () => {
  const base = 'basefyio.com';

  it.each([
    'app.basefyio.com',
    'api.basefyio.com',
    'api.basefyio.com:443',
    'basefyio.com',
    'www.basefyio.com',
    'db.basefyio.com',
    'storage.basefyio.com',
    'auth.basefyio.com',
    'admin.basefyio.com',
    'minio-console.basefyio.com',
    'traefik.basefyio.com',
    'sql.technoplatz.basefyio.com',
    'platform-api:4000',
    'localhost:4000',
    '10.0.0.7:4000',
    'technoplatz.example.com',
    'evilbasefyio.com',
    '',
  ])('leaves the platform host %j alone', (host) => {
    expect(classifyHost(host, base)).toEqual({ kind: 'platform' });
  });

  it('recognises a workspace address', () => {
    expect(classifyHost('Technoplatz.basefyio.com:443', base)).toEqual({
      kind: 'workspace',
      label: 'technoplatz',
      host: 'technoplatz.basefyio.com',
    });
  });

  it('still treats an unclaimable label as a workspace that will not resolve', () => {
    expect(classifyHost('bad_label.basefyio.com', base)).toMatchObject({ kind: 'workspace', label: 'bad_label' });
  });

  it('does nothing at all without a base domain', () => {
    expect(classifyHost('technoplatz.basefyio.com', null)).toEqual({ kind: 'platform' });
  });
});

describe('workspace URLs', () => {
  it('builds the host and the API URL', () => {
    expect(workspaceHost('technoplatz', 'basefyio.com')).toBe('technoplatz.basefyio.com');
    expect(workspaceApiUrl('technoplatz', 'basefyio.com')).toBe('https://technoplatz.basefyio.com');
  });
});
