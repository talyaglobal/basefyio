# basefyio E2E tests

Playwright end-to-end tests for critical user journeys.

```bash
cd e2e
npm install
npm run install:browsers
# Local stack:
npm test
# Against a deployed environment:
BASE_URL=https://app.basefyio.com npm test
```

`tests/smoke.spec.ts` covers public entry points (login renders, dashboard
redirects when unauthenticated). Extend with an authenticated flow — login ->
create project -> run SQL -> read results — using dedicated test credentials
(never production data).
