import { MetricsService } from './metrics.service';
import { classifyRoute } from './metrics.controller';

/**
 * The latency histogram and the in-flight gauge the capacity work reads,
 * and the route classifier that keeps tenant paths out of the labels.
 */
describe('MetricsService histogram', () => {
  it('buckets latency by route class and status class, in seconds', () => {
    const m = new MetricsService();
    m.observeRequest('GET', 200, 30, 'rest'); // 0.03 s → le=0.05 and above
    m.observeRequest('GET', 200, 400, 'rest'); // 0.4 s → le=0.5 and above
    m.observeRequest('POST', 503, 5, 'sql');
    const text = m.render();
    expect(text).toMatch(/basefyio_http_request_duration_seconds_bucket\{route_class="rest",status_class="2xx",le="0.025"\} 0/);
    expect(text).toMatch(/basefyio_http_request_duration_seconds_bucket\{route_class="rest",status_class="2xx",le="0.05"\} 1/);
    expect(text).toMatch(/basefyio_http_request_duration_seconds_bucket\{route_class="rest",status_class="2xx",le="0.5"\} 2/);
    expect(text).toMatch(/basefyio_http_request_duration_seconds_bucket\{route_class="rest",status_class="2xx",le="\+Inf"\} 2/);
    expect(text).toMatch(/basefyio_http_request_duration_seconds_count\{route_class="rest",status_class="2xx"\} 2/);
    expect(text).toMatch(/basefyio_http_request_duration_seconds_sum\{route_class="rest",status_class="2xx"\} 0.430000/);
    expect(text).toMatch(/basefyio_http_request_duration_seconds_count\{route_class="sql",status_class="5xx"\} 1/);
  });

  it('keeps the legacy per-method series exactly as they were', () => {
    const m = new MetricsService();
    m.observeRequest('GET', 200, 12);
    const text = m.render();
    expect(text).toMatch(/basefyio_http_requests_total\{method="GET",status="200"\} 1/);
    expect(text).toMatch(/duration_milliseconds_sum\{method="GET",status="200"\} 12/);
    expect(text).toMatch(/route_class="other"/);
  });

  it('tracks requests in flight and never goes below zero', () => {
    const m = new MetricsService();
    m.inflight(1);
    m.inflight(1);
    expect(m.render()).toMatch(/basefyio_inflight_requests 2/);
    m.inflight(-1);
    m.inflight(-1);
    m.inflight(-1);
    expect(m.currentInflight()).toBe(0);
  });
});

describe('classifyRoute', () => {
  it('names the surface and never the path', () => {
    expect(classifyRoute('/api/rest/v1/customer_orders?select=*')).toBe('rest');
    expect(classifyRoute('/api/sql/execute')).toBe('sql');
    expect(classifyRoute('/api/auth/login')).toBe('auth');
    expect(classifyRoute('/api/projects/p1/auth/users')).toBe('auth');
    expect(classifyRoute('/api/storage/v1/object/bucket/file.png')).toBe('storage');
    expect(classifyRoute('/api/realtime/v1/stream')).toBe('realtime');
    expect(classifyRoute('/api/admin/console/overview')).toBe('admin');
    expect(classifyRoute('/api/projects/p1/tables')).toBe('dashboard');
    expect(classifyRoute('/api/health/ready')).toBe('other');
    expect(classifyRoute('/_codefyio/catalog')).toBe('other');
  });
});
