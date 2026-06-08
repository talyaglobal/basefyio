# Basefyio Usage Guide
cli install: npm install -g basefyio-cli
sdk install: npm install basefyio-js
## CLI

```bash
npm install -g basefyio-cli
```

```bash
basefyio login                # Sign in to your account
basefyio init                 # Create a new project
basefyio link                 # Link to an existing project
basefyio status               # Show current project info
basefyio projects             # List all projects
basefyio db inspect           # Inspect database tables
basefyio db dump              # Dump database schema
```

Self-hosted users can specify a custom API URL:

```bash
basefyio login --api-url https://api.myserver.com
```

## SDK

```bash
npm install basefyio-js
```

### Setup

After `basefyio link` or `basefyio init`, your `.env` will contain:

```
BASEFYIO_PROJECT_ID=...
BASEFYIO_ANON_KEY=...
BASEFYIO_SERVICE_KEY=...
BASEFYIO_API_URL=https://api.basefyio.com
```

The SDK reads these automatically:

```js
import { createClient } from 'basefyio-js'

const kb = createClient()   // reads from .env

// or pass explicitly
const kb2 = createClient({ projectId: '...', apiKey: '...' })
```

### Auth

```js
await kb.auth.signUp({ email: 'alice@example.com', password: 'secret' })
await kb.auth.signIn({ email: 'alice@example.com', password: 'secret' })

const { data: user } = await kb.auth.getUser()
```

### Database

```js
// Query builder
const { data } = await kb.from('todos').select('*').eq('done', true).order('id')

// Insert
await kb.from('todos').insert({ title: 'New task', done: false })

// Update
await kb.from('todos').update({ done: true }).eq('id', 1)

// Delete
await kb.from('todos').delete().eq('id', 1)

// Raw SQL
await kb.sql('SELECT count(*) FROM todos')
```

### Storage

```js
// Create bucket
await kb.storage.createBucket('avatars', { public: true })

// Upload
const file = new Blob(['hello'], { type: 'text/plain' })
await kb.storage.from('avatars').upload('hello.txt', file)

// List files
const { data } = await kb.storage.from('avatars').list()

// Get signed URL
const { data: { url } } = await kb.storage.from('avatars').createSignedUrl('hello.txt')

// Delete
await kb.storage.from('avatars').remove(['hello.txt'])
```

