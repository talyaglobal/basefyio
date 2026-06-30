/**
 * Topological sort for provisioning plan actions.
 *
 * Ordering guarantee:
 *   1. Explicit deps: if action B declares `dependencies: ["type:name"]`, it executes after
 *      the referenced action (if present in the plan). Unknown refs are silently ignored.
 *   2. Implicit type-order: network(0) < server(1) < volume(2) < others(99). All
 *      lower-priority-type actions execute before all higher-priority-type actions,
 *      regardless of explicit deps.
 *
 * Cycle detection: Kahn's algorithm detects cycles and throws CircularDependencyError.
 * A backward explicit dep (e.g. network depending on server) creates a cycle with the
 * implicit type-order edges and is caught here.
 */

export const TYPE_ORDER: Record<string, number> = { network: 0, server: 1, volume: 2 };

const typePriority = (t: string): number => TYPE_ORDER[t.toLowerCase()] ?? 99;

export class CircularDependencyError extends Error {
  readonly code = 'CIRCULAR_DEPENDENCY';
  readonly retryable = false;

  constructor(public readonly cycle: string[]) {
    super(`Circular dependency in provisioning plan: ${cycle.join(' → ')}`);
    this.name = 'CircularDependencyError';
  }
}

export function topoSort<
  T extends { resourceType: string; resourceName: string; dependencies?: string[] },
>(actions: T[]): T[] {
  if (actions.length === 0) return [];

  const key = (a: T) => `${a.resourceType.toLowerCase()}:${a.resourceName}`;
  const indexByKey = new Map<string, number>(actions.map((a, i) => [key(a), i]));

  const inDegree = new Array<number>(actions.length).fill(0);
  const adj: number[][] = actions.map(() => []);
  const seen = new Set<string>();

  const addEdge = (from: number, to: number) => {
    const k = `${from}→${to}`;
    if (seen.has(k)) return;
    seen.add(k);
    adj[from].push(to);
    inDegree[to]++;
  };

  // Explicit dependency edges
  for (let i = 0; i < actions.length; i++) {
    for (const depKey of actions[i].dependencies ?? []) {
      const depIdx = indexByKey.get(depKey.toLowerCase());
      if (depIdx === undefined || depIdx === i) continue;
      addEdge(depIdx, i);
    }
  }

  // Implicit type-order edges: every lower-priority action → every higher-priority action
  for (let i = 0; i < actions.length; i++) {
    for (let j = 0; j < actions.length; j++) {
      if (i === j) continue;
      if (typePriority(actions[i].resourceType) < typePriority(actions[j].resourceType)) {
        addEdge(i, j);
      }
    }
  }

  // Kahn's algorithm (BFS, stable relative order within a tier)
  const queue: number[] = [];
  for (let i = 0; i < actions.length; i++) {
    if (inDegree[i] === 0) queue.push(i);
  }

  const result: T[] = [];
  while (queue.length > 0) {
    const idx = queue.shift()!;
    result.push(actions[idx]);
    for (const next of adj[idx]) {
      if (--inDegree[next] === 0) queue.push(next);
    }
  }

  if (result.length !== actions.length) {
    const inResultKeys = new Set(result.map(key));
    const cycle = actions.filter((a) => !inResultKeys.has(key(a))).map(key);
    throw new CircularDependencyError(cycle);
  }

  return result;
}
