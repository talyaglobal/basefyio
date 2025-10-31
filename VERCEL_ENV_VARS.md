# Vercel Environment Variables Reference

Copy these environment variables to your Vercel project settings.

## Required Variables

```env
DATABASE_URL=postgresql://username:password@host:5432/database?sslmode=require
JWT_SECRET=your_super_secret_jwt_key_here_min_32_chars
NEXT_PUBLIC_BASE_URL=https://your-project.vercel.app
```

## Recommended Variables

```env
KOLAYBASE_MASTER_KEY=your_master_key_for_secrets_encryption_min_32_chars
REFRESH_SECRET=your_refresh_token_secret_here
MAGIC_SECRET=your_magic_link_secret_here
```

## Optional: OAuth Configuration

```env
GITHUB_CLIENT_ID=your_github_oauth_client_id
GITHUB_CLIENT_SECRET=your_github_oauth_client_secret
GOOGLE_CLIENT_ID=your_google_oauth_client_id
GOOGLE_CLIENT_SECRET=your_google_oauth_client_secret
```

## Optional: Database Configuration

```env
DB_PROVIDER=neon
DB_MAX_CONNECTIONS=100
DB_POOL_MAX=20
```

## Quick Setup Script

To generate secure secrets locally:

```bash
# Generate JWT secret
node -e "console.log('JWT_SECRET=' + require('crypto').randomBytes(32).toString('hex'))"

# Generate Master Key
node -e "console.log('KOLAYBASE_MASTER_KEY=' + require('crypto').randomBytes(32).toString('hex'))"

# Generate Refresh Secret
node -e "console.log('REFRESH_SECRET=' + require('crypto').randomBytes(32).toString('hex'))"
```

## Where to Add in Vercel

1. Go to your project on [Vercel Dashboard](https://vercel.com/dashboard)
2. Navigate to **Settings** → **Environment Variables**
3. Add each variable for **Production**, **Preview**, and **Development** environments
4. Click **Save**

