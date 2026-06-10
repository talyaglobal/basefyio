import { HetznerLocationMapper } from './hetzner-location.mapper';

// ── Known region mappings ─────────────────────────────────────

describe('HetznerLocationMapper.resolve — known regions', () => {
  const CASES: [string, string][] = [
    ['eu-central',   'nbg1'],
    ['eu-west',      'hel1'],
    ['eu-south',     'fsn1'],
    ['us-east',      'ash'],
    ['us-west',      'hil'],
    ['ap-southeast', 'sin'],
  ];

  for (const [region, expected] of CASES) {
    it(`maps '${region}' → '${expected}'`, () => {
      expect(HetznerLocationMapper.resolve(region, null)).toBe(expected);
    });
  }
});

// ── Datacenter pin overrides region ──────────────────────────

describe('HetznerLocationMapper.resolve — datacenter pin', () => {
  it('returns datacenter directly when it is a known Hetzner location code', () => {
    expect(HetznerLocationMapper.resolve('eu-central', 'hel1')).toBe('hel1');
  });

  it('datacenter pin works even if region is unknown', () => {
    expect(HetznerLocationMapper.resolve('unknown-region', 'ash')).toBe('ash');
  });

  it('ignores unknown datacenter value and falls back to region', () => {
    expect(HetznerLocationMapper.resolve('eu-central', 'my-custom-dc')).toBe('nbg1');
  });

  it('null datacenter falls through to region resolution', () => {
    expect(HetznerLocationMapper.resolve('us-east', null)).toBe('ash');
  });
});

// ── Unknown region errors ────────────────────────────────────

describe('HetznerLocationMapper.resolve — unknown region', () => {
  it('throws for an unrecognised region with no valid datacenter', () => {
    expect(() => HetznerLocationMapper.resolve('ap-northeast', null)).toThrow(
      /No Hetzner location mapping for region 'ap-northeast'/,
    );
  });

  it('error message lists supported regions', () => {
    let msg = '';
    try {
      HetznerLocationMapper.resolve('mars-north', null);
    } catch (e) {
      msg = (e as Error).message;
    }
    expect(msg).toMatch(/eu-central/);
    expect(msg).toMatch(/us-east/);
  });

  it('error message includes valid datacenter location codes as alternative', () => {
    let msg = '';
    try {
      HetznerLocationMapper.resolve('bad-region', null);
    } catch (e) {
      msg = (e as Error).message;
    }
    expect(msg).toMatch(/nbg1/);
    expect(msg).toMatch(/ash/);
  });
});

// ── Utility methods ──────────────────────────────────────────

describe('HetznerLocationMapper — utility methods', () => {
  it('supportedRegions() includes all mapped region keys', () => {
    const regions = HetznerLocationMapper.supportedRegions();
    expect(regions).toContain('eu-central');
    expect(regions).toContain('us-east');
    expect(regions.length).toBeGreaterThanOrEqual(5);
  });

  it('knownLocationCodes() includes all mapped location values', () => {
    const codes = HetznerLocationMapper.knownLocationCodes();
    expect(codes).toContain('nbg1');
    expect(codes).toContain('ash');
    expect(codes.length).toBeGreaterThanOrEqual(5);
  });
});
