import { cpuPctBetween, parseLoadavg, parseMeminfo, parseProcStat } from './host-reader';

describe('host reader parsers', () => {
  it('reads the aggregate cpu line and computes busy share between two reads', () => {
    const a = parseProcStat('cpu  1000 0 500 8000 100 0 10 0 0 0\ncpu0 500 0 250 4000 50 0 5 0 0 0\n');
    const b = parseProcStat('cpu  1300 0 600 8500 150 0 20 0 0 0\n');
    expect(a).toEqual({ idle: 8100, total: 9610 });
    expect(b).toEqual({ idle: 8650, total: 10570 });
    // total delta 960, idle delta 550 → busy 410/960 = 42.7 %
    expect(cpuPctBetween(a!, b!)).toBe(42.7);
    expect(cpuPctBetween(b!, a!)).toBeNull();
  });

  it('reads MemTotal and MemAvailable', () => {
    expect(parseMeminfo('MemTotal:        7954112 kB\nMemFree:          612000 kB\nMemAvailable:    3804112 kB\n')).toEqual({
      totalKb: 7954112,
      availableKb: 3804112,
    });
    expect(parseMeminfo('nothing')).toBeNull();
  });

  it('reads loadavg', () => {
    expect(parseLoadavg('0.52 0.61 0.70 1/812 12345\n')).toEqual({ load1: 0.52, load5: 0.61, load15: 0.7 });
    expect(parseLoadavg('')).toBeNull();
  });
});
