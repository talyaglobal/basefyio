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

  /** Facts about this process that rarely change: which build it runs, whether it owns the schedule. */
  private readonly gauges = new Map<string, { help: string; samples: Map<string, number> }>();

  /**
   * Latency distribution by route class and status class. A class, never a
   * route: `rest`, `sql`, `auth`, `storage`, `realtime`, `dashboard`,
   * `admin`, `other` — eight values, so the series count stays fixed however
   * many tenants and tables exist. Buckets in seconds, as Prometheus expects.
   */
  private readonly histograms = new Map<string, { buckets: number[]; sum: number; count: number }>();
  private inflightCount = 0;

  static readonly LATENCY_BUCKETS = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10];

  /**
   * Cumulative request counts per route class and status class, for a reader
   * inside the process (the availability roll-up diffs them every 5 minutes).
   * This replica only, reset on restart — the same facts `render()` exposes.
   */
  routeStatusCounts(): Array<{ routeClass: string; statusClass: string; count: number }> {
    const out: Array<{ routeClass: string; statusClass: string; count: number }> = [];
    for (const [key, h] of this.histograms) {
      const [routeClass, statusClass] = key.split("|");
      out.push({ routeClass, statusClass, count: h.count });
    }
    return out;
  }

  /**
   * Record one finished request.
   *
   * The route is not a label. A project's tables and buckets appear in its
   * paths, so labelling by route would publish one series per customer table —
   * unbounded cardinality, and a map of every tenant's schema in the
   * monitoring system. Method and status answer the operational question
   * without either; the route class adds "which surface" without the path.
   */
  observeRequest(method: string, statusCode: number, ms: number, routeClass = 'other'): void {
    const key = `${method}|${statusCode}`;
    this.requests.set(key, (this.requests.get(key) ?? 0) + 1);
    this.durations.set(key, (this.durations.get(key) ?? 0) + ms);

    const statusClass = `${Math.floor(statusCode / 100)}xx`;
    const hkey = `${routeClass}|${statusClass}`;
    let h = this.histograms.get(hkey);
    if (!h) {
      h = { buckets: new Array(MetricsService.LATENCY_BUCKETS.length).fill(0), sum: 0, count: 0 };
      this.histograms.set(hkey, h);
    }
    const seconds = ms / 1000;
    MetricsService.LATENCY_BUCKETS.forEach((le, i) => {
      if (seconds <= le) h!.buckets[i] += 1;
    });
    h.sum += seconds;
    h.count += 1;
  }

  /** Requests currently being handled by this process. */
  inflight(delta: 1 | -1): void {
    this.inflightCount = Math.max(0, this.inflightCount + delta);
  }

  currentInflight(): number {
    return this.inflightCount;
  }

  /** Bump a named counter, for events worth alerting on. */
  increment(name: string, by = 1): void {
    this.counters.set(name, (this.counters.get(name) ?? 0) + by);
  }

  /**
   * Publish a gauge, replacing any earlier value for the same label set.
   *
   * The label string is emitted verbatim (`instance_id="api-1"`), so the caller
   * owns the cardinality: these are per-process facts — the replica's identity,
   * the build it runs, whether it holds the schedule — never per-request ones.
   */
  setGauge(name: string, help: string, labels: string, value: number): void {
    let gauge = this.gauges.get(name);
    if (!gauge) {
      gauge = { help, samples: new Map() };
      this.gauges.set(name, gauge);
    }
    gauge.samples.set(labels, value);
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

    add('basefyio_inflight_requests', 'gauge', 'Requests being handled by this process right now.', [
      ['', this.inflightCount],
    ]);

    for (const [name, gauge] of this.gauges) {
      add(name, 'gauge', gauge.help, [...gauge.samples]);
    }

    if (this.histograms.size > 0) {
      const name = 'basefyio_http_request_duration_seconds';
      out.push(`# HELP ${name} Request latency by route class and status class.`);
      out.push(`# TYPE ${name} histogram`);
      for (const [key, h] of this.histograms) {
        const [routeClass, statusClass] = key.split('|');
        const base = `route_class="${routeClass}",status_class="${statusClass}"`;
        MetricsService.LATENCY_BUCKETS.forEach((le, i) => {
          out.push(`${name}_bucket{${base},le="${le}"} ${h.buckets[i]}`);
        });
        out.push(`${name}_bucket{${base},le="+Inf"} ${h.count}`);
        out.push(`${name}_sum{${base}} ${h.sum.toFixed(6)}`);
        out.push(`${name}_count{${base}} ${h.count}`);
      }
    }

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
