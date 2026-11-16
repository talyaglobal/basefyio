import { describe, expect, it } from 'vitest';
import { sortProjectsByNewest } from './link';

const p = (name: string, createdAt?: string) => ({ name, createdAt });

describe('sortProjectsByNewest (bf link shows the most recent project first)', () => {
  it('puts the most recently created project at the top', () => {
    const out = sortProjectsByNewest([
      p('old', '2026-01-01T00:00:00.000Z'),
      p('newest', '2026-11-16T00:00:00.000Z'),
      p('middle', '2026-06-01T00:00:00.000Z'),
    ]);
    expect(out.map((x) => x.name)).toEqual(['newest', 'middle', 'old']);
  });

  it('sinks projects with no creation date below dated ones', () => {
    const out = sortProjectsByNewest([
      p('undated'),
      p('dated', '2026-01-01T00:00:00.000Z'),
    ]);
    expect(out.map((x) => x.name)).toEqual(['dated', 'undated']);
  });

  it('breaks ties on the name, locale-aware', () => {
    const out = sortProjectsByNewest([
      p('Zebra', '2026-05-01T00:00:00.000Z'),
      p('alpha', '2026-05-01T00:00:00.000Z'),
    ]);
    expect(out.map((x) => x.name)).toEqual(['alpha', 'Zebra']);
  });

  it('does not mutate the input array', () => {
    const input = [p('b', '2026-02-01T00:00:00.000Z'), p('a', '2026-03-01T00:00:00.000Z')];
    const copy = [...input];
    sortProjectsByNewest(input);
    expect(input).toEqual(copy);
  });
});
