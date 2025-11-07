# Kolaykey Project Setup Guide

This guide will help you set up the database and environment variables for the **Kolaykey** project.

## Quick Start

### 1. Create Environment File

Copy the example environment file:

```bash
cp .env.kolaykey.example .env.kolaykey
```

### 2. Configure Database Connection

Edit `.env.kolaykey` and update the `DATABASE_URL` with your PostgreSQL connection string:

```env
DATABASE_URL=postgresql://username:password@host:5432/kolaykey?sslmode=require
```

#### Database Options:

**Option A: Using Neon (Recommended for Serverless)**
1. Sign up at [neon.tech](https://neon.tech)
2. Create a new project
3. Copy the connection string to `DATABASE_URL`
4. Example: `postgresql://user:pass@ep-xxx.us-east-2.aws.neon.tech/kolaykey?sslmode=require`

**Option B: Using Local PostgreSQL**
1. Install PostgreSQL locally
2. Create a database: `createdb kolaykey`
3. Update `DATABASE_URL`: `postgresql://postgres:password@localhost:5432/kolaykey`

**Option C: Using Supabase**
1. Create a project at [supabase.com](https://supabase.com)
2. Get the connection string from Project Settings → Database
3. Copy to `DATABASE_URL`

### 3. Set Up the Database

Run the setup script to initialize all database tables:

```bash
node scripts/setup-kolaykey-db.js
```

This script will:
- ✅ Create all required database tables
- ✅ Set up indexes for optimal performance
- ✅ Initialize default storage buckets
- ✅ Configure realtime functionality
- ✅ Set up quota monitoring system
- ✅ Initialize edge functions and scheduling
- ✅ Create default admin user

### 4. Verify Installation

After setup, you should see:
- ✅ All tables created successfully
- ✅ Default admin user: `admin@kolaybase.com`
- ✅ Default password: `admin123` (⚠️ Change immediately!)

### 5. Start the Application

```bash
npm run dev
```

Visit [http://localhost:3000](http://localhost:3000) to access the application.

## Environment Variables

### Required Variables

| Variable | Description | Example |
|----------|-------------|---------|
| `DATABASE_URL` | PostgreSQL connection string | `postgresql://user:pass@host:5432/kolaykey` |
| `JWT_SECRET` | Secret for JWT tokens (min 32 chars) | Auto-generated |
| `NEXT_PUBLIC_BASE_URL` | Base URL of your application | `http://localhost:3000` |

### Recommended Variables

| Variable | Description | Auto-generated |
|----------|-------------|----------------|
| `KOLAYBASE_MASTER_KEY` | Master encryption key for secrets | ✅ Yes |
| `REFRESH_SECRET` | Secret for refresh tokens | ✅ Yes |
| `MAGIC_SECRET` | Secret for magic links | ✅ Yes |
| `STORAGE_SECRET` | Secret for file storage | ✅ Yes |

### Database Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `DB_PROVIDER` | `neon` | Database provider (neon, postgres, supabase) |
| `DB_MAX_CONNECTIONS` | `100` | Maximum database connections |
| `DB_POOL_MAX` | `20` | Connection pool maximum size |
| `DB_POOL_MIN` | `5` | Connection pool minimum size |

## Database Schema

The setup script creates the following tables:

### Core Tables
- `users` - User accounts
- `organizations` - Organizations/teams
- `organization_memberships` - Organization members
- `projects` - Projects within organizations
- `databases` - Database connections per project

### Feature Tables
- `api_keys` - API key management
- `storage_buckets` - File storage buckets
- `storage_files` - Stored files metadata
- `saved_queries` - Saved SQL queries
- `webhooks` - Webhook configurations
- `rls_policies` - Row Level Security policies

### Advanced Features
- `realtime_channels` - Realtime channels
- `realtime_subscriptions` - Realtime subscriptions
- `edge_functions` - Edge functions
- `scheduled_jobs` - Scheduled jobs
- `secrets` - Encrypted secrets
- `quota_thresholds` - Resource quota limits
- `resource_usage_log` - Resource usage tracking

## Default Credentials

⚠️ **IMPORTANT: Change these immediately after first login!**

- **Email**: `admin@kolaybase.com`
- **Password**: `admin123`

## Security Checklist

- [ ] Update `DATABASE_URL` with your actual database connection
- [ ] Generate new secrets for production (use `node scripts/generate-env-secrets.js`)
- [ ] Change default admin password
- [ ] Enable SSL for database connections (`?sslmode=require`)
- [ ] Set `NODE_ENV=production` for production deployments
- [ ] Store `KOLAYBASE_MASTER_KEY` securely (backup in safe location)
- [ ] Never commit `.env.kolaykey` to version control

## Troubleshooting

### Database Connection Errors

**Error: `DATABASE_URL environment variable is not set`**
- Make sure you've created `.env.kolaykey` from the example file
- Verify the file is in the project root directory

**Error: `Connection refused` or `Cannot connect to database`**
- Check that your PostgreSQL database is running
- Verify the connection string is correct
- Ensure network access is allowed (for cloud databases)

**Error: `Permission denied` or `Access denied`**
- Verify the database user has CREATE permissions
- Check that the database exists
- Ensure the user has access to the specified database

### Setup Script Errors

**Error: `relation already exists`**
- This is normal if tables already exist
- The script uses `IF NOT EXISTS` clauses
- You can safely re-run the script

**Error: `extension does not exist`**
- Ensure PostgreSQL version 13+ is installed
- Some extensions require superuser permissions

## Next Steps

1. **Create Your First Project**
   - Sign in with the admin account
   - Create a new organization
   - Add a project to the organization
   - Configure database connections

2. **Set Up API Keys**
   - Generate API keys for programmatic access
   - Configure scopes and permissions
   - Use keys for API authentication

3. **Configure Storage**
   - Set up storage buckets
   - Configure bucket permissions
   - Upload files via API or UI

4. **Enable Realtime**
   - Set up realtime channels
   - Subscribe to table changes
   - Use WebSocket connections

## Support

For issues or questions:
- Check the main [README.md](./README.md)
- Review [API documentation](./docs/api.md)
- Check [deployment guide](./docs/deployment.md)

## Scripts Reference

| Script | Description |
|--------|-------------|
| `node scripts/setup-kolaykey-db.js` | Initialize database for kolaykey project |
| `node scripts/generate-env-secrets.js` | Generate secure secrets |
| `node scripts/check-env.js` | Validate environment variables |
| `npm run db:setup` | General database setup (uses .env) |

