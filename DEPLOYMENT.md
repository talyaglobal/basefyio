# Vercel Deployment Guide

This guide will help you deploy Kolaybase to Vercel.

## Prerequisites

1. A Vercel account ([sign up here](https://vercel.com/signup))
2. A PostgreSQL database (recommended: [Neon](https://neon.tech) for serverless PostgreSQL)
3. GitHub/GitLab/Bitbucket repository (optional, for automatic deployments)

## Step 1: Prepare Your Database

### Using Neon (Recommended)

1. Create a new project at [neon.tech](https://neon.tech)
2. Copy your connection string - you'll need this for the `DATABASE_URL` environment variable
3. Run the database setup locally or via Neon's SQL editor:
   ```bash
   # On your local machine, after connecting to Neon
   npm run db:setup
   ```

### Database Setup SQL

If you can't run the setup script, you can manually run the SQL from `scripts/init-db.sql` using Neon's SQL editor.

## Step 2: Deploy to Vercel

### Option A: Deploy via Vercel Dashboard

1. **Import your project:**
   - Go to [Vercel Dashboard](https://vercel.com/dashboard)
   - Click "Add New" → "Project"
   - Import your Git repository or upload the code

2. **Configure the project:**
   - Framework Preset: **Next.js**
   - Root Directory: `./` (default)
   - Build Command: `npm run build` (default)
   - Output Directory: `.next` (default)

3. **Add Environment Variables:**
   Click on "Environment Variables" and add the following:

   **Required:**
   ```env
   DATABASE_URL=postgresql://user:password@host:5432/db?sslmode=require
   JWT_SECRET=your_super_secret_jwt_key_min_32_characters_long
   NEXT_PUBLIC_BASE_URL=https://your-project.vercel.app
   ```

   **Recommended:**
   ```env
   KOLAYBASE_MASTER_KEY=your_master_key_for_secrets_encryption_min_32_chars
   REFRESH_SECRET=your_refresh_token_secret
   ```

   **Optional (for OAuth):**
   ```env
   GITHUB_CLIENT_ID=your_github_client_id
   GITHUB_CLIENT_SECRET=your_github_client_secret
   GOOGLE_CLIENT_ID=your_google_client_id
   GOOGLE_CLIENT_SECRET=your_google_client_secret
   ```

   **Optional (Database Configuration):**
   ```env
   DB_PROVIDER=neon
   DB_MAX_CONNECTIONS=100
   DB_POOL_MAX=20
   ```

4. **Deploy:**
   - Click "Deploy"
   - Wait for the build to complete
   - Your app will be live at `https://your-project.vercel.app`

### Option B: Deploy via Vercel CLI

1. **Install Vercel CLI:**
   ```bash
   npm i -g vercel
   ```

2. **Login to Vercel:**
   ```bash
   vercel login
   ```

3. **Deploy:**
   ```bash
   vercel
   ```
   
   Follow the prompts:
   - Link to existing project or create new
   - Set up environment variables
   - Deploy to production: `vercel --prod`

## Step 3: Configure Environment Variables

### Generate Secure Secrets

You can generate secure secrets using:

```bash
# Generate JWT secret
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"

# Generate Master Key
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

### Set Environment Variables in Vercel

1. Go to your project settings in Vercel
2. Navigate to "Environment Variables"
3. Add each variable for all environments (Production, Preview, Development)

## Step 4: Database Initialization

After deployment, you need to initialize your database:

### Option 1: Run Setup Script Locally

```bash
# Set DATABASE_URL to your production database
export DATABASE_URL="your-production-connection-string"
npm run db:setup
```

### Option 2: Use Vercel CLI

```bash
vercel env pull .env.production
export $(cat .env.production | xargs)
npm run db:setup
```

### Option 3: Use Neon SQL Editor

Copy the contents of `scripts/init-db.sql` and run it in Neon's SQL editor.

## Step 5: Verify Deployment

1. **Visit your deployed URL:**
   ```
   https://your-project.vercel.app
   ```

2. **Test authentication:**
   - Default admin credentials (if setup script was run):
     - Email: `admin@kolaybase.com`
     - Password: `admin123`
   - ⚠️ **Important**: Change the password immediately in production!

3. **Check API endpoints:**
   ```
   https://your-project.vercel.app/api/openapi.json
   ```

## Configuration Details

### Function Timeouts

Some API routes have extended timeouts configured in `vercel.json`:
- Default API routes: 30 seconds
- Edge functions: 60 seconds
- Database operations: 60 seconds
- Migrations: 300 seconds (5 minutes)

### Regions

The app is configured to deploy to `iad1` (Washington, D.C.) for best performance with Neon. You can change this in `vercel.json`:

```json
"regions": ["iad1"]  // Change to your preferred region
```

### Serverless Functions

All API routes run as serverless functions on Vercel. The configuration in `vercel.json` ensures:
- Proper timeout settings for long-running operations
- Node.js runtime for functions that need Node.js modules
- Security headers applied to all routes

## Troubleshooting

### Build Fails

1. **Check build logs** in Vercel dashboard
2. **Verify all environment variables** are set
3. **Ensure TypeScript errors are resolved** (check locally with `npm run build`)

### Database Connection Issues

1. **Verify DATABASE_URL** is correct and includes SSL mode:
   ```
   ?sslmode=require
   ```
2. **Check Neon connection pooling** settings
3. **Verify IP allowlisting** if using IP-restricted databases

### Runtime Errors

1. **Check function logs** in Vercel dashboard
2. **Verify environment variables** are accessible
3. **Check database connection** and permissions

### Authentication Issues

1. **Verify JWT_SECRET** is set and consistent
2. **Check cookie settings** for your domain
3. **Ensure NEXT_PUBLIC_BASE_URL** matches your deployment URL

## Post-Deployment Checklist

- [ ] Database initialized and schema created
- [ ] All environment variables configured
- [ ] Default admin password changed
- [ ] OAuth providers configured (if using)
- [ ] SSL/HTTPS verified working
- [ ] API endpoints tested
- [ ] Authentication flow tested
- [ ] Real-time subscriptions tested (if using)
- [ ] Edge functions deployed (if using)
- [ ] Monitoring and analytics configured

## Continuous Deployment

If connected to a Git repository, Vercel will automatically deploy:
- **Production**: Pushes to main/master branch
- **Preview**: Pull requests and other branches

Environment variables are automatically available in all deployments.

## Custom Domain

To add a custom domain:

1. Go to Project Settings → Domains
2. Add your domain
3. Configure DNS records as instructed
4. Update `NEXT_PUBLIC_BASE_URL` environment variable

## Monitoring

- **Vercel Analytics**: Already integrated via `@vercel/analytics`
- **Function Logs**: Available in Vercel dashboard
- **Performance**: Check Vercel Analytics dashboard

## Support

For issues:
1. Check Vercel deployment logs
2. Review environment variables
3. Verify database connectivity
4. Check Next.js build output locally

## Notes

- **WebSockets**: Real-time features use Server-Sent Events (SSE) which work on Vercel
- **File Storage**: File uploads work but consider using Vercel Blob or external storage for production
- **Edge Functions**: Some functions require Node.js runtime (configured in vercel.json)
- **Database Connections**: Use connection pooling (Neon handles this automatically)

