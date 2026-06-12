import http from 'k6/http';
import { check, sleep } from 'k6';

export const options = {
  stages: [
    { duration: '10s', target: 5 },
    { duration: '20s', target: 20 },
    { duration: '10s', target: 0 },
  ],
  thresholds: {
    http_req_duration: ['p(95)<500'],
    http_req_failed: ['rate<0.02'],
  },
};

const BASE_URL = __ENV.BASE_URL || 'http://localhost:3000';
const TOKEN = __ENV.TOKEN || 'demo-token';
const PROJECT_ID = __ENV.PROJECT_ID || 'proj-load-test';

export default function () {
  // List items
  const listRes = http.get(
    `${BASE_URL}/v1/projects/${PROJECT_ID}/items/customers?limit=20`,
    { headers: { 'Authorization': `Bearer ${TOKEN}` } },
  );
  check(listRes, { 'list: 200': (r) => r.status === 200 });

  // Supabase-compat
  const compatRes = http.get(
    `${BASE_URL}/rest/v1/customers?select=*&limit=10`,
    { headers: { 'x-project-id': PROJECT_ID, 'Authorization': `Bearer ${TOKEN}` } },
  );
  check(compatRes, { 'compat: 200': (r) => r.status === 200 });

  sleep(0.5);
}
