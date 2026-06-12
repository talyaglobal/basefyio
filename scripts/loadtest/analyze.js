import http from 'k6/http';
import { check, sleep } from 'k6';

export const options = {
  vus: 10,
  duration: '30s',
  thresholds: {
    http_req_duration: ['p(95)<3000'], // 95% under 3s
    http_req_failed: ['rate<0.01'],    // <1% error rate
  },
};

const BASE_URL = __ENV.BASE_URL || 'http://localhost:3000';
const TOKEN = __ENV.TOKEN || 'demo-token';
const TEAM_ID = __ENV.TEAM_ID || 'team-load-test';

export default function () {
  const payload = JSON.stringify({
    teamId: TEAM_ID,
    sheets: [
      {
        sheet: 'Customers',
        headers: ['Name', 'Email', 'Status'],
        sampleRows: [['Alice', 'alice@test.com', 'active'], ['Bob', 'bob@test.com', 'inactive']],
      },
    ],
  });

  const res = http.post(`${BASE_URL}/v1/blueprints/analyze`, payload, {
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${TOKEN}` },
  });

  check(res, {
    'analyze: status 201 or 200': (r) => r.status === 201 || r.status === 200,
    'analyze: has blueprintId': (r) => JSON.parse(r.body)?.id !== undefined,
  });

  sleep(1);
}
