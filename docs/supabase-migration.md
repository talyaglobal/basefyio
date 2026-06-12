# Supabase Migration Guide

## 1. Point your Supabase client at kolaybase

```ts
import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  'https://<your-kolaybase-host>',  // replace with your deployment URL
  '<anon-key>',                      // any non-empty string (auth handled via x-project-id)
  {
    global: {
      headers: {
        'x-project-id': '<your-project-id>',
      },
    },
    // Disable realtime — not supported in V1
    realtime: { params: { eventsPerSecond: 0 } },
  },
);
```

The Supabase client will route REST calls to `/rest/v1/:table`, which kolaybase handles natively.

---

## 2. Supported client operations

### Select

```ts
const { data } = await supabase
  .from('customers')
  .select('*')
  .eq('status', 'active')
  .order('created_at', { ascending: false })
  .limit(20);
```

### Insert

```ts
const { data } = await supabase
  .from('customers')
  .insert({ name: 'Alice', status: 'active' });

// Bulk insert
const { data } = await supabase
  .from('customers')
  .insert([{ name: 'Alice' }, { name: 'Bob' }]);
```

### Update

```ts
const { data } = await supabase
  .from('customers')
  .update({ status: 'inactive' })
  .eq('id', '123');
```

### Delete

```ts
const { data } = await supabase
  .from('customers')
  .delete()
  .eq('id', '123');
```

---

## 3. What's different from Supabase

| Feature | Supabase | kolaybase V1 |
|---------|----------|-------------|
| Auth via supabase-js | Built-in auth | Not supported — use JWT / API key via `x-project-id` header |
| Realtime subscriptions | Yes | Not supported in V1 |
| Filter operators | Full set | Only `eq` enforced in V1 (others parsed but ignored) |
| Offset pagination | `?offset=N` | Ignored in V1 — use cursor-based pagination via native API |
| RPC / functions | `supabase.rpc()` | Not supported in V1 |
| Storage | Built-in | Use `/v1/projects/:id/items/:entity/:id/files` |

---

## 4. Migration checklist

- [ ] Replace `createClient(SUPABASE_URL, KEY)` with kolaybase URL and add `x-project-id` header
- [ ] Remove any `supabase.auth.*` calls — implement auth via platform JWT/API key
- [ ] Remove Supabase Realtime channel subscriptions
- [ ] Replace `supabase.rpc()` calls with direct REST calls to platform API
- [ ] Replace `supabase.storage.*` calls with file API (`/items/:entity/:id/files`)
- [ ] Verify filters — only `eq` is enforced; migrate complex filters to native API `filter[col]=value`
- [ ] Test pagination — replace `.range(from, to)` with cursor-based pagination for large datasets
