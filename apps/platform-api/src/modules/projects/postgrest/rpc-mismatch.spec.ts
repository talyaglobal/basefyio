import { describeRpcMismatch } from './rpc-mismatch';
import type { FunctionMeta } from './rpc';

const fn = (over: Partial<FunctionMeta>): FunctionMeta => ({
  signature: 'ensure_player(text)',
  definer: true,
  argnames: ['p_nick'],
  argmodes: [],
  pronargs: 1,
  pronargdefaults: 0,
  ...over,
});

describe('describeRpcMismatch', () => {
  it('names the missing argument instead of saying the function does not exist', () => {
    const msg = describeRpcMismatch('ensure_player', [fn({})], []);
    expect(msg).toMatch(/missing required argument: p_nick/);
    expect(msg).toMatch(/It takes: p_nick\./);
    expect(msg).not.toMatch(/not found/);
  });

  it('names an argument the function does not have', () => {
    const msg = describeRpcMismatch('ensure_player', [fn({})], ['p_nick', 'nickname']);
    expect(msg).toMatch(/unknown argument: nickname/);
    expect(msg).not.toMatch(/missing/);
  });

  it('reports both at once', () => {
    const msg = describeRpcMismatch('ensure_player', [fn({})], ['nickname']);
    expect(msg).toMatch(/missing required argument: p_nick; unknown argument: nickname/);
  });

  it('does not ask for an argument that has a default', () => {
    const meta = fn({ argnames: ['a', 'b'], pronargs: 2, pronargdefaults: 1, signature: 'f(integer, integer)' });
    expect(describeRpcMismatch('f', [meta], [])).toMatch(/missing required argument: a\./);
    expect(describeRpcMismatch('f', [meta], ['a', 'zzz'])).not.toMatch(/missing/);
  });

  it('ignores OUT parameters when it lists what the function takes', () => {
    const meta = fn({ argnames: ['p_id', 'out_name'], argmodes: ['i', 'o'], pronargs: 1, signature: 'f(uuid)' });
    expect(describeRpcMismatch('f', [meta], [])).toMatch(/It takes: p_id\./);
  });

  it('says a function with no arguments takes none', () => {
    const meta = fn({ argnames: [], pronargs: 0, signature: 'f()' });
    expect(describeRpcMismatch('f', [meta], ['x'])).toMatch(/unknown argument: x\. It takes no arguments\./);
  });

  it('lists the overloads when several exist', () => {
    const a = fn({ signature: 'f(integer)' });
    const b = fn({ signature: 'f(text, text)', argnames: ['x', 'y'], pronargs: 2 });
    const msg = describeRpcMismatch('f', [a, b], ['z']);
    expect(msg).toBe('Function "f" exists but no overload matches the arguments sent (z). Overloads: f(integer); f(text, text)');
  });
});
