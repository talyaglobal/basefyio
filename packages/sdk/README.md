# basefyio-js

JavaScript/TypeScript client for basefyio: database, auth, storage, collections and the data engine.

```bash
npm install basefyio-js
```

```ts
import { createClient } from 'basefyio-js';

const basefyio = createClient({ projectId: 'YOUR_PROJECT_ID', apiKey: 'YOUR_ANON_KEY' });

const { data, error } = await basefyio.from('todos').select('*').eq('done', false);
```

## Requirements

- Node.js 18 or newer (uses the built-in `fetch`, `FormData` and `Blob`). Browsers: any evergreen browser.
- Realtime: Node 22+ (global `EventSource`) or an `EventSource` polyfill on older runtimes.

## Configuration

`createClient()` with no arguments reads `BASEFYIO_PROJECT_ID`, `BASEFYIO_ANON_KEY` and `BASEFYIO_API_URL`
from the environment. That only works on the server; in a browser pass `projectId` and `apiKey` explicitly.
The legacy `KOLAYBASE_*` variable names are still read as a fallback.

## Notes

- `bigint`, `numeric` and `COUNT(*)` values come back as strings (Postgres wire types); convert them yourself.
- `orRaw()` injects its argument into the SQL condition. Never pass user input to it.
- `VERSION` is exported for diagnostics.

Docs: https://basefyio.com/docs/sdk
