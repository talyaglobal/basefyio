# Load Test Scripts

Run with [k6](https://k6.io):

```bash
# Install k6: brew install k6

# Analyze endpoint load test
BASE_URL=http://localhost:3000 TOKEN=<jwt> TEAM_ID=team-1 k6 run scripts/loadtest/analyze.js

# Items CRUD load test
BASE_URL=http://localhost:3000 TOKEN=<jwt> PROJECT_ID=proj-1 k6 run scripts/loadtest/items-crud.js
```

## Thresholds

| Endpoint | p95 target | Error rate |
|----------|-----------|------------|
| POST /blueprints/analyze | < 3s | < 1% |
| GET /items/:entity | < 500ms | < 2% |
| GET /rest/v1/:table | < 500ms | < 2% |
