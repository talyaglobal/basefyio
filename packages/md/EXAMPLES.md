# basefyio CLI Examples

Quick examples for common CLI workflows.

## Getting Started

### First Time Setup

```bash
# Install CLI
npm install -g basefyio-cli

# Login
basefyio login

# Create a new project
basefyio init --name "My First Project"

# Start development
basefyio start
```

## Project Management

### Create Multiple Projects

```bash
# Create projects for different environments
basefyio projects:create --name "my-app-dev"
basefyio projects:create --name "my-app-staging"
basefyio projects:create --name "my-app-prod"

# List all projects
basefyio projects
```

### Switch Between Projects

```bash
# In project directory 1
cd ~/projects/my-app-dev
basefyio link --project-id abc-123

# In project directory 2
cd ~/projects/my-app-prod
basefyio link --project-id xyz-789
```

## Database Workflows

### Schema Migration Workflow

```bash
# 1. Make changes to schema.prisma or SQL files

# 2. Push changes to database
basefyio db push

# 3. Generate types
basefyio gen types

# 4. Commit changes
git add .
git commit -m "Add users table"
```

### Database Reset and Reseed

```bash
# Reset database
basefyio db reset --force

# Push schema
basefyio db push

# Seed with data
basefyio db seed
```

### Pull Schema from Production

```bash
# Link to production project
basefyio link --project-id prod-id

# Pull schema
basefyio db pull

# Save to version control
git add prisma/schema.prisma
git commit -m "Update schema from production"
```

## Code Generation

### Generate Full Stack Types

```bash
# Generate database types
basefyio gen types --output ./types

# Generate TypeScript client
basefyio gen client --lang typescript --output ./lib

# Generate Python client for backend
basefyio gen client --lang python --output ./python-api/lib
```

### Example: Using Generated Client

After running `basefyio gen client`:

```typescript
// lib/basefyio.ts is generated
import { createClient } from './lib/basefyio';

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
basefyio start

# Terminal 2: Watch logs
basefyio logs --follow

# Terminal 3: Development
cd my-app
npm run dev
```

### API Development

```bash
# Start only infrastructure (no UI/API)
basefyio start --no-ui --no-api

# In your API directory
cd apps/my-api
npm run dev

# View SQL logs in another terminal
basefyio logs --sql --follow
```

## Secrets Management

### Setup Environment Variables

```bash
# Set database credentials
basefyio secrets set DATABASE_URL postgresql://user:pass@host:5432/db

# Set API keys
basefyio secrets set STRIPE_SECRET_KEY sk_test_...
basefyio secrets set SENDGRID_API_KEY SG....

# List all secrets (sensitive values masked)
basefyio secrets list
```

### Share Secrets Between Environments

```bash
# Export from dev
cd my-app-dev
basefyio secrets list > secrets.txt

# Import to staging (manually)
cd my-app-staging
basefyio secrets set KEY1 value1
basefyio secrets set KEY2 value2
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
        run: npm install -g basefyio-cli
      
      - name: Login
        run: |
          echo "${{ secrets.KB_ACCESS_TOKEN }}" | basefyio login
      
      - name: Link to production project
        run: basefyio link --project-id ${{ secrets.KB_PROJECT_ID }}
      
      - name: Push database changes
        run: basefyio db push
      
      - name: Run migrations
        run: npm run migrate
```

### Docker Deployment

```dockerfile
FROM node:20-alpine

# Install KB CLI
RUN npm install -g basefyio-cli

# Copy app
WORKDIR /app
COPY . .

# Install dependencies
RUN npm install

# Login and link (using build args)
ARG KB_ACCESS_TOKEN
ARG KB_PROJECT_ID
RUN basefyio link --project-id $KB_PROJECT_ID

CMD ["npm", "start"]
```

## Team Collaboration

### Setup for New Team Member

```bash
# 1. Install CLI
npm install -g basefyio-cli

# 2. Login with team credentials
basefyio login

# 3. Clone project repository
git clone https://github.com/team/project.git
cd project

# 4. Link to shared project
basefyio link

# 5. Start development
basefyio start
```

### Share Project Access

```bash
# Team lead creates project
basefyio projects:create --name "Team Project"

# Share project ID with team
basefyio projects  # Copy project ID

# Team members link to it
basefyio link --project-id <shared-project-id>
```

## Monitoring and Debugging

### View Real-time Logs

```bash
# All container logs
basefyio logs --follow

# SQL queries only
basefyio logs --sql --follow

# Last 100 lines
basefyio logs --tail 100
```

### Debug Database Issues

```bash
# Check current status
basefyio status

# Reset and start fresh
basefyio db reset --force
basefyio db push

# View recent SQL errors
basefyio logs --sql --tail 50
```

### Monitor Service Health

```bash
# Check all services
basefyio status

# Restart if needed
basefyio stop
basefyio start

# View specific service logs
basefyio logs
```

## Advanced Workflows

### Multi-Database Development

```bash
# Create separate projects for microservices
basefyio projects:create --name "users-service"
basefyio projects:create --name "payments-service"
basefyio projects:create --name "notifications-service"

# In each service directory, link to its project
cd services/users && basefyio link --project-id users-id
cd services/payments && basefyio link --project-id payments-id
```

### Schema Versioning

```bash
# Before major schema change
basefyio db pull > schema-backup-$(date +%Y%m%d).sql

# Make changes
# ... edit schema ...

# Push with caution
basefyio db push

# If something goes wrong, restore
basefyio db reset --force
basefyio db push < schema-backup-20260223.sql
```

### Custom SQL Scripts

```bash
# Run custom migration
basefyio db push < migrations/001-add-indexes.sql

# Run data transformation
basefyio db push < scripts/transform-data.sql

# Verify
basefyio logs --sql
```

## Tips and Tricks

### Alias for Speed

```bash
# Add to ~/.bashrc or ~/.zshrc
alias bfs='basefyio start'
alias bfst='basefyio stop'
alias bfl='basefyio logs --follow'
alias bfp='basefyio db push && basefyio gen types'
```

### Quick Project Switch

```bash
# Create a shell function
bfswitch() {
  cd ~/projects/$1
  basefyio link
  basefyio start
}

# Usage
bfswitch my-app-dev
```

### Backup Before Destructive Operations

```bash
# Always pull schema before reset
basefyio db pull
basefyio db reset --force
basefyio db push
```

### Check Everything is Working

```bash
# Quick health check script
basefyio status && \
basefyio logs --tail 10 && \
echo "✓ All systems operational"
```

## Common Issues

### Port Already in Use

```bash
# Find and kill process using port
lsof -ti:5432 | xargs kill -9
lsof -ti:8080 | xargs kill -9

# Or change ports in .env
basefyio secrets set POSTGRES_PORT 5433
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
basefyio link --project-id <your-project-id>

# Verify connection
basefyio status
```
