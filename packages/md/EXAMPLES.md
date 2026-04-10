# Kolaybase CLI Examples

Quick examples for common CLI workflows.

## Getting Started

### First Time Setup

```bash
# Install CLI
npm install -g @kolaybase/cli

# Login
kb login

# Create a new project
kb init --name "My First Project"

# Start development
kb start
```

## Project Management

### Create Multiple Projects

```bash
# Create projects for different environments
kb projects:create --name "my-app-dev"
kb projects:create --name "my-app-staging"
kb projects:create --name "my-app-prod"

# List all projects
kb projects
```

### Switch Between Projects

```bash
# In project directory 1
cd ~/projects/my-app-dev
kb link --project-id abc-123

# In project directory 2
cd ~/projects/my-app-prod
kb link --project-id xyz-789
```

## Database Workflows

### Schema Migration Workflow

```bash
# 1. Make changes to schema.prisma or SQL files

# 2. Push changes to database
kb db push

# 3. Generate types
kb gen types

# 4. Commit changes
git add .
git commit -m "Add users table"
```

### Database Reset and Reseed

```bash
# Reset database
kb db reset --force

# Push schema
kb db push

# Seed with data
kb db seed
```

### Pull Schema from Production

```bash
# Link to production project
kb link --project-id prod-id

# Pull schema
kb db pull

# Save to version control
git add prisma/schema.prisma
git commit -m "Update schema from production"
```

## Code Generation

### Generate Full Stack Types

```bash
# Generate database types
kb gen types --output ./types

# Generate TypeScript client
kb gen client --lang typescript --output ./lib

# Generate Python client for backend
kb gen client --lang python --output ./python-api/lib
```

### Example: Using Generated Client

After running `kb gen client`:

```typescript
// lib/kolaybase.ts is generated
import { createClient } from './lib/kolaybase';

const client = createClient({
  url: process.env.NEXT_PUBLIC_API_URL,
  anonKey: process.env.ANON_KEY,
});

// Query data
const users = await client.table('users').select();

// Insert data
await client.table('users').insert({
  name: 'John Doe',
  email: 'john@example.com',
});
```

## Development Workflows

### Full Stack Development

```bash
# Terminal 1: Start infrastructure
kb start

# Terminal 2: Watch logs
kb logs --follow

# Terminal 3: Development
cd my-app
npm run dev
```

### API Development

```bash
# Start only infrastructure (no UI/API)
kb start --no-ui --no-api

# In your API directory
cd apps/my-api
npm run dev

# View SQL logs in another terminal
kb logs --sql --follow
```

## Secrets Management

### Setup Environment Variables

```bash
# Set database credentials
kb secrets set DATABASE_URL postgresql://user:pass@host:5432/db

# Set API keys
kb secrets set STRIPE_SECRET_KEY sk_test_...
kb secrets set SENDGRID_API_KEY SG....

# List all secrets (sensitive values masked)
kb secrets list
```

### Share Secrets Between Environments

```bash
# Export from dev
cd my-app-dev
kb secrets list > secrets.txt

# Import to staging (manually)
cd my-app-staging
kb secrets set KEY1 value1
kb secrets set KEY2 value2
```

## CI/CD Integration

### GitHub Actions Example

```yaml
# .github/workflows/deploy.yml
name: Deploy

on:
  push:
    branches: [main]

jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v2
      
      - name: Install KB CLI
        run: npm install -g @kolaybase/cli
      
      - name: Login
        run: |
          echo "${{ secrets.KB_ACCESS_TOKEN }}" | kb login
      
      - name: Link to production project
        run: kb link --project-id ${{ secrets.KB_PROJECT_ID }}
      
      - name: Push database changes
        run: kb db push
      
      - name: Run migrations
        run: npm run migrate
```

### Docker Deployment

```dockerfile
FROM node:20-alpine

# Install KB CLI
RUN npm install -g @kolaybase/cli

# Copy app
WORKDIR /app
COPY . .

# Install dependencies
RUN npm install

# Login and link (using build args)
ARG KB_ACCESS_TOKEN
ARG KB_PROJECT_ID
RUN kb link --project-id $KB_PROJECT_ID

CMD ["npm", "start"]
```

## Team Collaboration

### Setup for New Team Member

```bash
# 1. Install CLI
npm install -g @kolaybase/cli

# 2. Login with team credentials
kb login

# 3. Clone project repository
git clone https://github.com/team/project.git
cd project

# 4. Link to shared project
kb link

# 5. Start development
kb start
```

### Share Project Access

```bash
# Team lead creates project
kb projects:create --name "Team Project"

# Share project ID with team
kb projects  # Copy project ID

# Team members link to it
kb link --project-id <shared-project-id>
```

## Monitoring and Debugging

### View Real-time Logs

```bash
# All container logs
kb logs --follow

# SQL queries only
kb logs --sql --follow

# Last 100 lines
kb logs --tail 100
```

### Debug Database Issues

```bash
# Check current status
kb status

# Reset and start fresh
kb db reset --force
kb db push

# View recent SQL errors
kb logs --sql --tail 50
```

### Monitor Service Health

```bash
# Check all services
kb status

# Restart if needed
kb stop
kb start

# View specific service logs
kb logs
```

## Advanced Workflows

### Multi-Database Development

```bash
# Create separate projects for microservices
kb projects:create --name "users-service"
kb projects:create --name "payments-service"
kb projects:create --name "notifications-service"

# In each service directory, link to its project
cd services/users && kb link --project-id users-id
cd services/payments && kb link --project-id payments-id
```

### Schema Versioning

```bash
# Before major schema change
kb db pull > schema-backup-$(date +%Y%m%d).sql

# Make changes
# ... edit schema ...

# Push with caution
kb db push

# If something goes wrong, restore
kb db reset --force
kb db push < schema-backup-20260223.sql
```

### Custom SQL Scripts

```bash
# Run custom migration
kb db push < migrations/001-add-indexes.sql

# Run data transformation
kb db push < scripts/transform-data.sql

# Verify
kb logs --sql
```

## Tips and Tricks

### Alias for Speed

```bash
# Add to ~/.bashrc or ~/.zshrc
alias kbs='kb start'
alias kbst='kb stop'
alias kbl='kb logs --follow'
alias kbp='kb db push && kb gen types'
```

### Quick Project Switch

```bash
# Create a shell function
kbswitch() {
  cd ~/projects/$1
  kb link
  kb start
}

# Usage
kbswitch my-app-dev
```

### Backup Before Destructive Operations

```bash
# Always pull schema before reset
kb db pull
kb db reset --force
kb db push
```

### Check Everything is Working

```bash
# Quick health check script
kb status && \
kb logs --tail 10 && \
echo "✓ All systems operational"
```

## Common Issues

### Port Already in Use

```bash
# Find and kill process using port
lsof -ti:5432 | xargs kill -9
lsof -ti:8080 | xargs kill -9

# Or change ports in .env
kb secrets set POSTGRES_PORT 5433
```

### Docker Out of Memory

```bash
# Increase Docker memory limit
# Docker Desktop > Settings > Resources > Memory

# Or stop unused containers
docker system prune -a
```

### Lost Connection to Project

```bash
# Re-link to project
kb link --project-id <your-project-id>

# Verify connection
kb status
```
