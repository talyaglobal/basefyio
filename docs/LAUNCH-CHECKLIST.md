# Launch Checklist

## Pre-launch (engineering gate)

### Security
- [ ] Tenant isolation audit spec: all tests green (`tenant-isolation.audit.spec.ts`)
- [ ] Rebrand check: `bash scripts/check-rebrand.sh` exits 0
- [ ] SQL injection patterns blocked in `/intelligence/ask`
- [ ] File upload size limit enforced (50MB)
- [ ] RLS policies applied on all blueprint-generated tables

### Infrastructure
- [ ] PostgreSQL backup policy configured (daily + WAL archiving)
- [ ] MinIO bucket lifecycle policies (staging objects expire 7d)
- [ ] Redis persistence enabled (AOF or RDB)
- [ ] BullMQ dead-letter queue monitored
- [ ] Sentry (or equivalent) error tracking configured
- [ ] Health check endpoints: `GET /health` returns 200

### Performance
- [ ] k6 analyze load test: p95 < 3s at 10 VUs
- [ ] k6 items CRUD load test: p95 < 500ms at 20 VUs
- [ ] Blueprint generate job: completes in < 60s for 10-table blueprints
- [ ] nfyio-runtime: first contentful paint < 2s (Next.js build)

### Quality
- [ ] Platform-API test suite: 100% green
- [ ] SDK tests: 100% green  
- [ ] CLI tests: 100% green
- [ ] Blueprint package tests: 100% green
- [ ] TypeScript: `npx tsc --noEmit` exits 0 (excluding pre-existing @basefyio/data-engine)

## Post-launch (ops gate)

### Monitoring
- [ ] Grafana dashboard: blueprint pipeline (analyze → generate → runtime)
- [ ] Alert: blueprint generate job failure rate > 5%
- [ ] Alert: /intelligence/ask error rate > 10%
- [ ] Alert: project database connection pool exhaustion

### Documentation
- [ ] `docs/content-layer.md` published
- [ ] `docs/supabase-migration.md` published
- [ ] AppSource manifest validated in Office Add-in validator
- [ ] API changelog updated

### Go-to-market
- [ ] Demo tenant seeded with realistic data
- [ ] `scripts/demo-excel-to-app.sh` runs end-to-end
- [ ] AppSource submission package prepared
- [ ] Support runbook in Notion/Confluence
