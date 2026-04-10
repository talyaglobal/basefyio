# Kolaybase CLI

The official command-line interface for [Kolaybase](https://github.com/fsipka/kolaybase-new) - a self-hosted, multi-tenant backend platform.

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
npm install -g kolaybase-cli
```

### Build from source

```bash
git clone https://github.com/fsipka/kolaybase-new.git
cd v0-kolaybase/packages/cli
npm install
npm run build
npm link
```

## Quick Start

### 1. Login

```bash
kb login
```

### 2. Initialize a new project

```bash
mkdir my-project
cd my-project
kb init
```

### 3. Start local development

```bash
kb start
```

### 4. Generate TypeScript types

```bash
kb gen types
```

## Commands

### Authentication

#### `kb login`

Login to your Kolaybase account.

```bash
kb login
```

### Project Management

#### `kb init`

Initialize a new Kolaybase project in the current directory.

```bash
kb init
kb init --name "My Project"
kb init --link  # Link to existing project
```

#### `kb projects`

List all your projects.

```bash
kb projects
kb projects:list
```

#### `kb projects:create`

Create a new project.

```bash
kb projects:create
kb projects:create --name "My Project" --description "My awesome project"
```

#### `kb projects:delete <projectId>`

Delete a project (requires confirmation).

```bash
kb projects:delete abc-123-def
```

### Local Development

#### `kb start`

Start the local Kolaybase development environment (Docker Compose).

```bash
kb start
kb start --no-ui    # Skip starting Admin UI
kb start --no-api   # Skip starting Platform API
```

#### `kb stop`

Stop the local development environment.

```bash
kb stop
```

#### `kb status`

Show the status of local services.

```bash
kb status
```

### Database Management

#### `kb db push`

Push local schema changes to the remote database.

```bash
kb db push
```

#### `kb db pull`

Pull remote schema to local (introspection).

```bash
kb db pull
```

#### `kb db reset`

Reset the database (drops all tables).

```bash
kb db reset
kb db reset --force  # Skip confirmation
```

#### `kb db seed`

Seed the database with initial data.

```bash
kb db seed
```

#### `kb db diff`

Show schema differences between local and remote.

```bash
kb db diff
```

### Code Generation

#### `kb gen types`

Generate TypeScript types from database schema.

```bash
kb gen types
kb gen types --output ./types
```

#### `kb gen client`

Generate API client for your project.

```bash
kb gen client
kb gen client --lang typescript --output ./lib
kb gen client --lang javascript
kb gen client --lang python
```

### Logs

#### `kb logs`

View container logs.

```bash
kb logs
kb logs --follow         # Follow log output
kb logs --tail 100       # Show last 100 lines
kb logs --sql            # Show SQL audit logs
```

### Secrets Management

#### `kb secrets list`

List all environment secrets.

```bash
kb secrets list
```

#### `kb secrets set <key> <value>`

Set an environment secret.

```bash
kb secrets set API_KEY my-secret-key
kb secrets set DATABASE_URL postgresql://...
```

#### `kb secrets unset <key>`

Remove an environment secret.

```bash
kb secrets unset API_KEY
```

### Project Linking

#### `kb link`

Link current directory to a remote project.

```bash
kb link
kb link --project-id abc-123
```

#### `kb unlink`

Unlink current directory from remote project.

```bash
kb unlink
```

## Configuration

### Global Configuration

Global configuration is stored in:
- **macOS/Linux**: `~/.config/kolaybase/config.json`
- **Windows**: `%APPDATA%\kolaybase\config.json`

Contains:
- API URL
- Access tokens
- User information

### Project Configuration

Project-specific configuration is stored in `.kolaybase/config.json`:

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

# Login to Kolaybase
kb login

# Initialize project
kb init --name "My App"

# Start local environment
kb start

# Generate types
kb gen types

# Generate client
kb gen client --lang typescript
```

### Work with an existing project

```bash
# Clone your app repository
git clone https://github.com/me/my-app.git
cd my-app

# Link to remote project
kb link

# Start local environment
kb start

# Pull latest schema
kb db pull
```

### Database workflow

```bash
# Make schema changes in Prisma or SQL files

# Push to database
kb db push

# Generate updated types
kb gen types

# Seed with data
kb db seed

# View SQL logs
kb logs --sql
```

## Environment Detection

The CLI automatically detects your environment:

- If you're in a Kolaybase project (has `.kolaybase/` directory), it uses that configuration
- Otherwise, it looks for a global Kolaybase installation
- Commands like `kb start` work from anywhere if Kolaybase is installed

## Troubleshooting

### "Docker is not running"

Make sure Docker Desktop is running:

```bash
docker ps
```

### "Not in a Kolaybase project"

Initialize a project or link to an existing one:

```bash
kb init
# or
kb link
```

### "Authentication failed"

Check your credentials and API URL:

```bash
kb login
```

### "Could not connect to API"

Make sure the Platform API is running:

```bash
kb start
kb status
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
kb --version
```

## Contributing

Contributions are welcome! Please open an issue or PR.

## License

Private - All rights reserved.
