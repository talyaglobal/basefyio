import { topoSort, CircularDependencyError, TYPE_ORDER } from './provisioning-topo-sort';

// helper to build minimal action objects
function act(resourceType: string, resourceName: string, dependencies?: string[]) {
  return { resourceType, resourceName, action: 'CREATE' as const, reason: '', dependencies };
}

describe('topoSort — empty / single', () => {
  it('returns [] for empty input', () => {
    expect(topoSort([])).toEqual([]);
  });

  it('returns [action] for a single action', () => {
    const a = act('server', 'web-1');
    expect(topoSort([a])).toEqual([a]);
  });
});

describe('topoSort — implicit type ordering', () => {
  it('TYPE_ORDER has network=0, server=1, volume=2', () => {
    expect(TYPE_ORDER['network']).toBe(0);
    expect(TYPE_ORDER['server']).toBe(1);
    expect(TYPE_ORDER['volume']).toBe(2);
  });

  it('network before server when input is [server, network]', () => {
    const server = act('server', 'web-1');
    const network = act('network', 'net-1');
    const result = topoSort([server, network]);
    expect(result.indexOf(network)).toBeLessThan(result.indexOf(server));
  });

  it('network before volume, server before volume', () => {
    const volume = act('volume', 'vol-1');
    const server = act('server', 'web-1');
    const network = act('network', 'net-1');
    const result = topoSort([volume, server, network]);
    expect(result.indexOf(network)).toBeLessThan(result.indexOf(volume));
    expect(result.indexOf(server)).toBeLessThan(result.indexOf(volume));
  });

  it('server before volume when only server+volume present', () => {
    const volume = act('volume', 'vol-1');
    const server = act('server', 'web-1');
    const result = topoSort([volume, server]);
    expect(result.indexOf(server)).toBeLessThan(result.indexOf(volume));
  });

  it('actions with unknown type (priority 99) come after server', () => {
    const unknown = act('loadbalancer', 'lb-1');
    const server = act('server', 'web-1');
    const result = topoSort([unknown, server]);
    expect(result.indexOf(server)).toBeLessThan(result.indexOf(unknown));
  });

  it('preserves relative order within same type (two servers: original order kept)', () => {
    const server1 = act('server', 'web-1');
    const server2 = act('server', 'web-2');
    const result = topoSort([server1, server2]);
    expect(result.indexOf(server1)).toBeLessThan(result.indexOf(server2));
  });
});

describe('topoSort — explicit dependencies', () => {
  it('respects explicit dep: server-b after server-a when b.dependencies=["server:server-a"]', () => {
    const serverA = act('server', 'server-a');
    const serverB = act('server', 'server-b', ['server:server-a']);
    const result = topoSort([serverB, serverA]);
    expect(result.indexOf(serverA)).toBeLessThan(result.indexOf(serverB));
  });

  it('ignores dep key not present in actions', () => {
    const server = act('server', 'web-1', ['network:ghost-net']);
    // Should not throw and should return the single action
    expect(() => topoSort([server])).not.toThrow();
    expect(topoSort([server])).toEqual([server]);
  });

  it('explicit dep overrides natural position within same type', () => {
    // vol-2 depends on vol-1 even though they have the same type; vol-1 must come first
    const vol1 = act('volume', 'vol-1');
    const vol2 = act('volume', 'vol-2', ['volume:vol-1']);
    // Input order has vol-2 first
    const result = topoSort([vol2, vol1]);
    expect(result.indexOf(vol1)).toBeLessThan(result.indexOf(vol2));
  });
});

describe('topoSort — circular dependency guard', () => {
  it('throws CircularDependencyError when two same-type actions depend on each other', () => {
    const serverA = act('server', 'server-a', ['server:server-b']);
    const serverB = act('server', 'server-b', ['server:server-a']);
    expect(() => topoSort([serverA, serverB])).toThrow(CircularDependencyError);
  });

  it('thrown error has code="CIRCULAR_DEPENDENCY" and retryable=false', () => {
    const serverA = act('server', 'server-a', ['server:server-b']);
    const serverB = act('server', 'server-b', ['server:server-a']);
    let caught: unknown;
    try {
      topoSort([serverA, serverB]);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(CircularDependencyError);
    const error = caught as CircularDependencyError;
    expect(error.code).toBe('CIRCULAR_DEPENDENCY');
    expect(error.retryable).toBe(false);
  });

  it('thrown error cycle array contains both node keys', () => {
    const serverA = act('server', 'server-a', ['server:server-b']);
    const serverB = act('server', 'server-b', ['server:server-a']);
    let caught: unknown;
    try {
      topoSort([serverA, serverB]);
    } catch (err) {
      caught = err;
    }
    const error = caught as CircularDependencyError;
    expect(error.cycle).toContain('server:server-a');
    expect(error.cycle).toContain('server:server-b');
  });

  it('throws when a backward explicit dep creates a cycle with implicit type-order edges (network explicitly depends on server)', () => {
    // Implicit edges: network → server (network comes before server).
    // Adding server as explicit dep of network creates: network → server → network — a cycle.
    const network = act('network', 'net-1', ['server:web-1']);
    const server = act('server', 'web-1');
    expect(() => topoSort([network, server])).toThrow(CircularDependencyError);
  });
});

describe('topoSort — mixed plan', () => {
  it('correctly orders network+server+volume in a 6-action plan (3 types, 2 each)', () => {
    const net1 = act('network', 'net-1');
    const net2 = act('network', 'net-2');
    const srv1 = act('server', 'web-1');
    const srv2 = act('server', 'web-2');
    const vol1 = act('volume', 'vol-1');
    const vol2 = act('volume', 'vol-2');
    // Shuffle input order
    const result = topoSort([vol1, srv1, net1, vol2, net2, srv2]);
    // All networks before all servers
    for (const net of [net1, net2]) {
      for (const srv of [srv1, srv2]) {
        expect(result.indexOf(net)).toBeLessThan(result.indexOf(srv));
      }
    }
    // All networks before all volumes
    for (const net of [net1, net2]) {
      for (const vol of [vol1, vol2]) {
        expect(result.indexOf(net)).toBeLessThan(result.indexOf(vol));
      }
    }
    // All servers before all volumes
    for (const srv of [srv1, srv2]) {
      for (const vol of [vol1, vol2]) {
        expect(result.indexOf(srv)).toBeLessThan(result.indexOf(vol));
      }
    }
    // All 6 actions present
    expect(result).toHaveLength(6);
  });

  it('DELETE actions are also sorted by type order', () => {
    const delVolume = { resourceType: 'volume', resourceName: 'vol-1', action: 'DELETE' as const, reason: '' };
    const delServer = { resourceType: 'server', resourceName: 'web-1', action: 'DELETE' as const, reason: '' };
    const delNetwork = { resourceType: 'network', resourceName: 'net-1', action: 'DELETE' as const, reason: '' };
    const result = topoSort([delVolume, delServer, delNetwork]);
    expect(result.indexOf(delNetwork)).toBeLessThan(result.indexOf(delServer));
    expect(result.indexOf(delServer)).toBeLessThan(result.indexOf(delVolume));
  });
});
