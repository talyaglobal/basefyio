---
date: 2026-06-08
slug: basefyio-rebrand
title: "Welcome to Basefyio — We Have a New Name"
kind: feature
version: v2.0.0
summary: Kolaybase is now Basefyio. New name, new domain, same powerful backend platform. All CLI commands, SDKs, and APIs have been updated.
---

We're excited to announce that **Kolaybase is now Basefyio**. This rebrand reflects our vision of making backend development effortless for developers everywhere.

---

## What changed

### New domain

All services now live under **basefyio.com**:

- Dashboard: [app.basefyio.com](https://app.basefyio.com)
- API: [api.basefyio.com](https://api.basefyio.com)
- Website: [basefyio.com](https://basefyio.com)

### New CLI command

The CLI command has changed from `kb` to `basefyio`:

```bash
basefyio login
basefyio init
basefyio link
basefyio status
basefyio db push
```

### New SDK package

The JavaScript/TypeScript SDK has been renamed:

```bash
npm install basefyio-js
```

```typescript
import { BasefyioClient } from 'basefyio-js';

const client = new BasefyioClient({
  projectId: 'your-project-id',
  anonKey: 'your-anon-key',
});
```

### Updated environment variables

All environment variable prefixes have changed from `KOLAYBASE_*` to `BASEFYIO_*`:

| Before | After |
|--------|-------|
| `KOLAYBASE_API_URL` | `BASEFYIO_API_URL` |
| `KOLAYBASE_ANON_KEY` | `BASEFYIO_ANON_KEY` |
| `KOLAYBASE_SERVICE_KEY` | `BASEFYIO_SERVICE_KEY` |
| `KOLAYBASE_PROJECT_ID` | `BASEFYIO_PROJECT_ID` |
| `KOLAYBASE_DATABASE_URL` | `BASEFYIO_DATABASE_URL` |

---

## What didn't change

- **Your data** — all databases, storage buckets, and auth realms are untouched
- **Your API keys** — existing keys continue to work
- **Core functionality** — everything works exactly as before, just under a new name

---

## Migration guide

1. **Update CLI**: Run `npm install -g basefyio-cli`
2. **Update SDK**: Replace `kolaybase-js` with `basefyio-js` in your `package.json`
3. **Update env vars**: Rename `KOLAYBASE_*` variables to `BASEFYIO_*`
4. **Update imports**: `KolaybaseClient` is now `BasefyioClient`
5. **Update bookmarks**: The dashboard is now at `app.basefyio.com`
