import { readFile } from 'fs/promises';
import * as os from 'os';

/**
 * Host CPU, memory and load from the kernel's own counters. `/host/proc` is
 * the host's /proc mounted read-only into the container; without it the
 * numbers describe the container's cgroup view and are flagged as such.
 */
export interface HostSample {
  /** 0..100, CPU busy share since the previous sample (null on the first one). */
  cpuPct: number | null;
  cores: number;
  memTotalMb: number;
  memUsedMb: number;
  memAvailableMb: number;
  load1: number;
  load5: number;
  load15: number;
  /** 'host' when read from /host/proc, 'container' when from this process's view. */
  source: 'host' | 'container';
}

export interface CpuTotals {
  idle: number;
  total: number;
}

export function parseProcStat(text: string): CpuTotals | null {
  const line = text.split('\n').find((l) => l.startsWith('cpu '));
  if (!line) return null;
  const parts = line.trim().split(/\s+/).slice(1).map((n) => Number(n));
  if (parts.length < 4 || parts.some((n) => Number.isNaN(n))) return null;
  const [user, nice, system, idle, iowait = 0, irq = 0, softirq = 0, steal = 0] = parts;
  const idleAll = idle + iowait;
  const total = user + nice + system + idle + iowait + irq + softirq + steal;
  return { idle: idleAll, total };
}

export function cpuPctBetween(prev: CpuTotals, next: CpuTotals): number | null {
  const total = next.total - prev.total;
  if (total <= 0) return null;
  const idle = next.idle - prev.idle;
  return Math.round(((total - idle) / total) * 1000) / 10;
}

export function parseMeminfo(text: string): { totalKb: number; availableKb: number } | null {
  const grab = (key: string) => {
    const m = text.match(new RegExp(`^${key}:\\s+(\\d+)\\s+kB`, 'm'));
    return m ? Number(m[1]) : null;
  };
  const total = grab('MemTotal');
  const available = grab('MemAvailable') ?? grab('MemFree');
  if (total === null || available === null) return null;
  return { totalKb: total, availableKb: available };
}

export function parseLoadavg(text: string): { load1: number; load5: number; load15: number } | null {
  const parts = text.trim().split(/\s+/);
  if (parts.length < 3 || parts[0] === '') return null;
  const [a, b, c] = parts.slice(0, 3).map((n) => Number(n));
  if ([a, b, c].some((n) => Number.isNaN(n))) return null;
  return { load1: a, load5: b, load15: c };
}

export class HostReader {
  private prev: CpuTotals | null = null;

  constructor(private readonly procRoot = process.env.HOST_PROC_PATH || '/host/proc') {}

  async read(): Promise<HostSample> {
    const [stat, meminfo, loadavg] = await Promise.all([
      readFile(`${this.procRoot}/stat`, 'utf8').catch(() => null),
      readFile(`${this.procRoot}/meminfo`, 'utf8').catch(() => null),
      readFile(`${this.procRoot}/loadavg`, 'utf8').catch(() => null),
    ]);
    const totals = stat ? parseProcStat(stat) : null;
    const mem = meminfo ? parseMeminfo(meminfo) : null;
    const load = loadavg ? parseLoadavg(loadavg) : null;
    const fromHost = !!(totals && mem && load);

    let cpuPct: number | null = null;
    if (totals) {
      cpuPct = this.prev ? cpuPctBetween(this.prev, totals) : null;
      this.prev = totals;
    }
    const cores = fromHost ? countCores(stat as string) : os.cpus().length;
    const memTotalMb = mem ? Math.round(mem.totalKb / 1024) : Math.round(os.totalmem() / 1048576);
    const memAvailableMb = mem ? Math.round(mem.availableKb / 1024) : Math.round(os.freemem() / 1048576);
    const [l1, l5, l15] = load ? [load.load1, load.load5, load.load15] : os.loadavg();
    return {
      cpuPct,
      cores,
      memTotalMb,
      memUsedMb: memTotalMb - memAvailableMb,
      memAvailableMb,
      load1: l1,
      load5: l5,
      load15: l15,
      source: fromHost ? 'host' : 'container',
    };
  }
}

function countCores(stat: string): number {
  const n = stat.split('\n').filter((l) => /^cpu\d+\s/.test(l)).length;
  return n > 0 ? n : os.cpus().length;
}
