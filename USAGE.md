# Kolaybase Usage Guide
cli install: npm install -g kolaybase-cli
sdk install: npm install kolaybase-js
## CLI

```bash
npm install -g kolaybase-cli
```

```bash
kb login                # Sign in to your account
kb init                 # Create a new project
kb link                 # Link to an existing project
kb status               # Show current project info
kb projects             # List all projects
kb db inspect           # Inspect database tables
kb db dump              # Dump database schema
```

Self-hosted users can specify a custom API URL:

```bash
kb login --api-url https://api.myserver.com
```

## SDK

```bash
npm install kolaybase-js
```

### Setup

```js
import { createClient } from 'kolaybase-js'

const kb = createClient({ projectId: 'your-project-id' })
```

### Auth

```js
await kb.auth.signUp({ username: 'alice', email: 'alice@example.com', password: 'secret' })
await kb.auth.signIn({ username: 'alice', password: 'secret' })

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

