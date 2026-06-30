# admin-ui (planned — not yet implemented)

The basefyio admin dashboard is **not part of v0.1**. This directory is a
placeholder so the intended layout is visible; it ships no code, no
`package.json`, and no `Dockerfile` yet.

Because there is nothing to build, the `admin-ui` service is commented out in
[`docker-compose.yml`](../../docker-compose.yml) and excluded from the Compose
stack. When the dashboard lands, add its `Dockerfile`, uncomment the Compose
service, and update `README.md` / `docs/architecture.md` to match.
