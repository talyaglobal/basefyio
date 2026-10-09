import { Injectable } from '@nestjs/common';

/**
 * Counters an operator needs, in Prometheus exposition format.
 *
 * Written by hand rather than with a client library on purpose. The format is
 * plain text, the set of series here is small and fixed, and the alternative
 * was a new runtime dependency and a lockfile change on the path to
 * production. If the series ever stop being a fixed set, swap this for
 * prom-client rather than growing it.
 *
 * Series are kept in memory, so they reset when the process restarts and they
 * describe one container rather than the deployment. Both are normal for a
 * scrape target: Prometheus handles counter resets, and several replicas are
 * scraped separately.
 */
@Injectable()
export class MetricsService {
  private readonly startedAt = Date.now();

  /** method + status + outcome → count. The route is deliberately absent; see below. */
  private readonly requests = new Map<string, number>();

  /** method + status → total milliseconds, paired with `requests` for an average. */
  private readonly durations = new Map<string, number>();

  private readonly counters = new Map<string, number>();

  /**
   * Record one finished request.
   *
   * The route is not a label. A project's tables and buckets appear in its
   * paths, so labelling by route would publish one series per customer table —
   * unbounded cardinality, and a map of every tenant's schema in the
   * monitoring system. Method and status answer the operational question
   * without either.
   */
  observeRequest(method: string, statusCode: number, ms: number): void {
    const key = `${method}|${statusCode}`;
    this.requests.set(key, (this.requests.get(key) ?? 0) + 1);
    this.durations.set(key, (this.durations.get(key) ?? 0) + ms);
  }

  /** Bump a named counter, for events worth alerting on. */
  increment(name: string, by = 1): void {
    this.counters.set(name, (this.counters.get(name) ?? 0) + by);
  }

  render(): string {
    const out: string[] = [];
    const mem = process.memoryUsage();
    const cpu = process.cpuUsage();

    const add = (name: string, type: string, help: string, samples: Array<[string, number]>) => {
      if (!samples.length) return;
      out.push(`# HELP ${name} ${help}`);
      out.push(`# TYPE ${name} ${type}`);
      for (const [labels, value] of samples) {
        out.push(labels ? `${name}{${labels}} ${value}` : `${name} ${value}`);
      }
    };

    add('basefyio_uptime_seconds', 'gauge', 'Seconds since this process started.', [
      ['', Math.round((Date.now() - this.startedAt) / 1000)],
    ]);
    add('basefyio_process_resident_memory_bytes', 'gauge', 'Resident set size.', [['', mem.rss]]);
    add('basefyio_process_heap_used_bytes', 'gauge', 'Heap in use.', [['', mem.heapUsed]]);
    add('basefyio_process_cpu_seconds_total', 'counter', 'User plus system CPU time.', [
      ['', (cpu.user + cpu.system) / 1e6],
    ]);

    add(
      'basefyio_http_requests_total',
      'counter',
      'Requests served, by method and status. Routes are not labelled: they contain tenant table and bucket names.',
      [...this.requests].map(([key, value]) => {
        const [method, status] = key.split('|');
        return [`method="${method}",status="${status}"`, value] as [string, number];
      }),
    );

    add(
      'basefyio_http_request_duration_milliseconds_sum',
      'counter',
      'Summed request duration, by method and status. Divide by the request count for a mean.',
      [...this.durations].map(([key, value]) => {
        const [method, status] = key.split('|');
        return [`method="${method}",status="${status}"`, Math.round(value)] as [string, number];
      }),
    );

    add(
      'basefyio_events_total',
      'counter',
      'Named events worth alerting on, such as a key refused on a route it may not reach.',
      [...this.counters].map(([name, value]) => [`event="${name}"`, value] as [string, number]),
    );

    return out.join('\n') + '\n';
  }
}
