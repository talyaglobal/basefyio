import {
  MAX_ALLOWED_CIDRS,
  buildHbaFile,
  hasRestrictions,
  isHbaSafeName,
  normalizeCidr,
  normalizeCidrList,
} from './pgbouncer-hba';

describe('normalizeCidr', () => {
  it.each([
    ['203.0.113.7', '203.0.113.7/32', 4],
    [' 203.0.113.7/32 ', '203.0.113.7/32', 4],
    ['203.0.113.7/24', '203.0.113.0/24', 4],
    ['10.1.2.3/8', '10.0.0.0/8', 4],
    ['255.255.255.255/1', '128.0.0.0/1', 4],
    ['2001:db8::1', '2001:db8::1/128', 6],
    ['2001:DB8:0:0:0:0:0:1/64', '2001:db8::/64', 6],
    ['2001:db8:abcd:12::/48', '2001:db8:abcd::/48', 6],
    ['::ffff:192.0.2.1', '::ffff:c000:201/128', 6],
    ['fe80::1:0:0:1/128', 'fe80::1:0:0:1/128', 6],
    ['1:0:0:2:0:0:0:3', '1:0:0:2::3/128', 6],
    ['1:2:3:4:5:6:7:8', '1:2:3:4:5:6:7:8/128', 6],
  ])('%j → %j', (input, value, family) => {
    expect(normalizeCidr(input)).toEqual({ ok: true, value, family });
  });

  it.each([
    '',
    '   ',
    'example.com',
    '203.0.113',
    '203.0.113.256',
    '203.0.113.7/33',
    '203.0.113.7/',
    '203.0.113.7/ 8',
    '203.0.113.7/24/1',
    '2001:db8::1/129',
    '2001:db8::1%eth0',
    '0.0.0.0/0',
    '::/0',
  ])('refuses %j', (input) => {
    const r = normalizeCidr(input);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toMatch(/\w/);
  });

  it('refuses a non-string', () => {
    expect(normalizeCidr(42).ok).toBe(false);
  });
});

describe('normalizeCidrList', () => {
  it('normalises, de-duplicates and keeps the order', () => {
    expect(normalizeCidrList(['198.51.100.9', '203.0.113.7/24', '203.0.113.0/24', '198.51.100.9/32'])).toEqual({
      ok: true,
      value: ['198.51.100.9/32', '203.0.113.0/24'],
    });
  });

  it('names the first bad entry', () => {
    const r = normalizeCidrList(['198.51.100.9', 'nope']);
    expect(r).toEqual({ ok: false, message: expect.stringContaining('"nope"') });
  });

  it('refuses something that is not a list', () => {
    expect(normalizeCidrList('198.51.100.9').ok).toBe(false);
  });

  it('caps the list', () => {
    const many = Array.from({ length: MAX_ALLOWED_CIDRS + 1 }, (_, i) => `10.0.${Math.floor(i / 250)}.${i % 250}`);
    expect(normalizeCidrList(many).ok).toBe(false);
    expect(normalizeCidrList(many.slice(0, MAX_ALLOWED_CIDRS)).ok).toBe(true);
  });
});

describe('hasRestrictions / isHbaSafeName', () => {
  it('only counts a policy that restricts something', () => {
    expect(hasRestrictions(null)).toBe(false);
    expect(hasRestrictions({ requireTls: false, allowedCidrs: [] })).toBe(false);
    expect(hasRestrictions({ requireTls: true, allowedCidrs: [] })).toBe(true);
    expect(hasRestrictions({ requireTls: false, allowedCidrs: ['10.0.0.0/8'] })).toBe(true);
  });

  it('accepts the names the platform allocates and nothing that needs quoting', () => {
    expect(isHbaSafeName('kb_0123456789abcdef')).toBe(true);
    expect(isHbaSafeName('kb_my-shop')).toBe(true);
    expect(isHbaSafeName('all')).toBe(false);
    expect(isHbaSafeName('kb a')).toBe(false);
    expect(isHbaSafeName('kb,a')).toBe(false);
    expect(isHbaSafeName('"kb"')).toBe(false);
  });
});

describe('buildHbaFile', () => {
  const tail = ['# Every other database', 'host all all 0.0.0.0/0 password', 'host all all ::/0 password', 'local all all password', ''];

  it('admits every database as before when no project has rules', () => {
    const lines = buildHbaFile([]).split('\n');
    expect(lines.slice(-tail.length)).toEqual(tail);
    expect(lines.filter((l) => l && !l.startsWith('#'))).toEqual([
      'host all all 0.0.0.0/0 password',
      'host all all ::/0 password',
      'local all all password',
    ]);
  });

  it('allows listed addresses only, then rejects the rest of that database', () => {
    const file = buildHbaFile([{ dbName: 'kb_a', requireTls: false, allowedCidrs: ['203.0.113.0/24', '2001:db8::/32'] }]);
    expect(file).toContain(
      [
        '# kb_a: allowed: 203.0.113.0/24, 2001:db8::/32',
        'host kb_a all 203.0.113.0/24 password',
        'host kb_a all 2001:db8::/32 password',
        'host kb_a all 0.0.0.0/0 reject',
        'host kb_a all ::/0 reject',
      ].join('\n'),
    );
    // The project's reject lines come before the catch-all that admits everyone else.
    expect(file.indexOf('host kb_a all 0.0.0.0/0 reject')).toBeLessThan(file.indexOf('host all all 0.0.0.0/0 password'));
  });

  it('requires TLS from any address', () => {
    const file = buildHbaFile([{ dbName: 'kb_b', requireTls: true, allowedCidrs: [] }]);
    expect(file).toContain(
      [
        '# kb_b: TLS required; any address',
        'hostssl kb_b all 0.0.0.0/0 password',
        'hostssl kb_b all ::/0 password',
        'host kb_b all 0.0.0.0/0 reject',
        'host kb_b all ::/0 reject',
      ].join('\n'),
    );
  });

  it('combines TLS and an allow list', () => {
    const file = buildHbaFile([{ dbName: 'kb_c', requireTls: true, allowedCidrs: ['198.51.100.9/32'] }]);
    expect(file).toContain('hostssl kb_c all 198.51.100.9/32 password\nhost kb_c all 0.0.0.0/0 reject');
    expect(file).not.toContain('hostssl kb_c all 0.0.0.0/0');
  });

  it('skips projects without restrictions and names it cannot write safely', () => {
    const file = buildHbaFile([
      { dbName: 'kb_open', requireTls: false, allowedCidrs: [] },
      { dbName: 'bad name', requireTls: true, allowedCidrs: [] },
    ]);
    expect(file).not.toContain('kb_open');
    expect(file).not.toContain('bad name');
  });
});
