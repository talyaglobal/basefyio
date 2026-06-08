# Basefyio CLI

The official command-line interface for [Basefyio](https://github.com/fsipka/basefyio-new) - a self-hosted, multi-tenant backend platform.

## Features

- 🚀 **Quick project initialization** - Get started in seconds
- 🔐 **Authentication** - Login and manage your account
- 📦 **Project management** - Create, list, and delete projects
- 🐳 **Local development** - Start/stop local environment with Docker
- 🗄️ **Database tools** - Push, pull, reset, and seed databases
- 🔧 **Code generation** - Generate TypeScript types and API clients
- 📊 **Logs & monitoring** - View container and SQL audit logs
- 🔑 **Secrets management** - Manage environment variables

## Installation

### NPM

```bash
npm install -g basefyio-cli
```

### Build from source

```bash
git clone https://github.com/fsipka/basefyio-new.git
cd v0-basefyio/packages/cli
npm install
npm run build
npm link
```

## Quick Start

### 1. Login

```bash
basefyio login
```

### 2. Initialize a new project

```bash
mkdir my-project
cd my-project
basefyio init
```

### 3. Start local development

```bash
basefyio start
```

### 4. Generate TypeScript types

```bash
basefyio gen types
```

## Commands

### Authentication

#### `basefyio login`

Login to your Basefyio account.

```bash
basefyio login
```

### Project Management

#### `basefyio init`

Initialize a new Basefyio project in the current directory.

```bash
basefyio init
basefyio init --name "My Project"
basefyio init --link  # Link to existing project
```

#### `basefyio projects`

List all your projects.

```bash
basefyio projects
basefyio projects:list
```

#### `basefyio projects:create`

Create a new project.

```bash
basefyio projects:create
basefyio projects:create --name "My Project" --description "My awesome project"
```

#### `basefyio projects:delete <projectId>`

Delete a project (requires confirmation).

```bash
basefyio projects:delete abc-123-def
```

### Local Development

#### `basefyio start`

Start the local Basefyio development environment (Docker Compose).

```bash
basefyio start
basefyio start --no-ui    # Skip starting Admin UI
basefyio start --no-api   # Skip starting Platform API
```

#### `basefyio stop`

Stop the local development environment.

```bash
basefyio stop
```

#### `basefyio status`

Show the status of local services.

```bash
basefyio status
```

### Database Management

#### `basefyio db push`

Push local schema changes to the remote database.

```bash
basefyio db push
```

#### `basefyio db pull`

Pull remote schema to local (introspection).

```bash
basefyio db pull
```

#### `basefyio db reset`

Reset the database (drops all tables).

```bash
basefyio db reset
basefyio db reset --force  # Skip confirmation
```

#### `basefyio db seed`

Seed the database with initial data.

```bash
basefyio db seed
```

#### `basefyio db diff`

Show schema differences between local and remote.

```bash
basefyio db diff
```

### Code Generation

#### `basefyio gen types`

Generate TypeScript types from database schema.

```bash
basefyio gen types
basefyio gen types --output ./types
```

#### `basefyio gen client`

Generate API client for your project.

```bash
basefyio gen client
basefyio gen client --lang typescript --output ./lib
basefyio gen client --lang javascript
basefyio gen client --lang python
```

### Logs

#### `basefyio logs`

View container logs.

```bash
basefyio logs
basefyio logs --follow         # Follow log output
basefyio logs --tail 100       # Show last 100 lines
basefyio logs --sql            # Show SQL audit logs
```

### Secrets Management

#### `basefyio secrets list`

List all environment secrets.

```bash
basefyio secrets list
```

#### `basefyio secrets set <key> <value>`

Set an environment secret.

```bash
basefyio secrets set API_KEY my-secret-key
basefyio secrets set DATABASE_URL postgresql://...
```

#### `basefyio secrets unset <key>`

Remove an environment secret.

```bash
basefyio secrets unset API_KEY
```

### Project Linking

#### `basefyio link`

Link current directory to a remote project.

```bash
basefyio link
basefyio link --project-id abc-123
```

#### `basefyio unlink`

Unlink current directory from remote project.

```bash
basefyio unlink
```

## Configuration

### Global Configuration

Global configuration is stored in:
- **macOS/Linux**: `~/.config/basefyio/config.json`
- **Windows**: `%APPDATA%\basefyio\config.json`

Contains:
- API URL
- Access tokens
- User information

### Project Configuration

Project-specific configuration is stored in `.basefyio/config.json`:

```json
{
  "projectId": "abc-123",
  "projectName": "My Project",
  "projectSlug": "my-project",
  "teamId": "team-456",
  "linkedAt": "2026-02-23T..."
}
```

### Environment Variables

Project environment variables are stored in `.env`:

```bash
PROJECT_ID=abc-123
PROJECT_NAME=My Project
DATABASE_URL=postgresql://...
ANON_KEY=...
SERVICE_KEY=...
```

## Usage Examples

### Create a new project from scratch

```bash
# Create project directory
mkdir my-app && cd my-app

# Login to Basefyio
basefyio login

# Initialize project
basefyio init --name "My App"

# Start local environment
basefyio start

# Generate types
basefyio gen types

# Generate client
basefyio gen client --lang typescript
```

### Work with an existing project

```bash
# Clone your app repository
git clone https://github.com/me/my-app.git
cd my-app

# Link to remote project
basefyio link

# Start local environment
basefyio start

# Pull latest schema
basefyio db pull
```

### Database workflow

```bash
# Make schema changes in Prisma or SQL files

# Push to database
basefyio db push

# Generate updated types
basefyio gen types

# Seed with data
basefyio db seed

# View SQL logs
basefyio logs --sql
```

## Environment Detection

The CLI automatically detects your environment:

- If you're in a Basefyio project (has `.basefyio/` directory), it uses that configuration
- Otherwise, it looks for a global Basefyio installation
- Commands like `basefyio start` work from anywhere if Basefyio is installed

## Troubleshooting

### "Docker is not running"

Make sure Docker Desktop is running:

```bash
docker ps
```

### "Not in a Basefyio project"

Initialize a project or link to an existing one:

```bash
basefyio init
# or
basefyio link
```

### "Authentication failed"

Check your credentials and API URL:

```bash
basefyio login
```

### "Could not connect to API"

Make sure the Platform API is running:

```bash
basefyio start
basefyio status
```

## Development

### Build the CLI

```bash
cd packages/cli
npm install
npm run build
```

### Watch mode

```bash
npm run dev
```

### Link for local testing

```bash
npm link
basefyio --version
```

## Contributing

Contributions are welcome! Please open an issue or PR.

## License

Private - All rights reserved.
