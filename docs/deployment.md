# Kolaybase Deployment Guide

This guide covers deploying Kolaybase to various platforms and environments.

## Environment Variables

Before deploying, ensure you have the following environment variables configured:

### Required Variables

```env
# Database Connection
DATABASE_URL=postgresql://username:password@host:5432/database

# JWT Secret for authentication
JWT_SECRET=your-super-secret-jwt-key-here-make-it-long-and-random

# Next.js URL (for production)
NEXTAUTH_URL=https://yourdomain.com
```

### Optional Variables

```env
# Master key for secrets encryption (recommended for production)
KOLAYBASE_MASTER_KEY=your-master-encryption-key

# File upload configuration
MAX_FILE_SIZE=10485760  # 10MB in bytes
ALLOWED_FILE_TYPES=image/*,text/*,application/pdf

# Rate limiting
RATE_LIMIT_REQUESTS=1000
RATE_LIMIT_WINDOW=60000  # 1 minute in ms

# CORS settings
ALLOWED_ORIGINS=https://yourapp.com,https://yourdomain.com
```

## Platform Deployments

### Vercel (Recommended)

Vercel provides seamless deployment for Next.js applications.

#### Step 1: Prepare Your Repository
```bash
# Ensure your project is in a Git repository
git add .
git commit -m "Prepare for deployment"
git push origin main
```

#### Step 2: Deploy to Vercel
1. Go to [vercel.com](https://vercel.com) and sign in
2. Click "New Project" and import your repository
3. Configure environment variables in the Vercel dashboard
4. Deploy

#### Step 3: Database Setup
Use [Neon](https://neon.tech) for a serverless PostgreSQL database:

1. Create a new Neon project
2. Copy the connection string
3. Add `DATABASE_URL` to your Vercel environment variables
4. Redeploy to apply changes

#### Vercel Configuration
Create `vercel.json` in your project root:
```json
{
  "framework": "nextjs",
  "buildCommand": "npm run build",
  "devCommand": "npm run dev",
  "installCommand": "npm install",
  "functions": {
    "app/api/**/*.ts": {
      "maxDuration": 10
    }
  },
  "env": {
    "DATABASE_URL": "@database_url",
    "JWT_SECRET": "@jwt_secret"
  }
}
```

### Netlify

#### Step 1: Build Configuration
Create `netlify.toml`:
```toml
[build]
  command = "npm run build"
  publish = ".next"

[build.environment]
  NODE_VERSION = "18"

[[redirects]]
  from = "/api/*"
  to = "/.netlify/functions/:splat"
  status = 200

[[redirects]]
  from = "/*"
  to = "/index.html"
  status = 200
```

#### Step 2: Deploy
1. Connect your repository to Netlify
2. Set environment variables in Netlify dashboard
3. Deploy

### Railway

Railway offers simple deployment with built-in PostgreSQL.

#### Step 1: Install Railway CLI
```bash
npm install -g @railway/cli
```

#### Step 2: Login and Deploy
```bash
railway login
railway init
railway up
```

#### Step 3: Add PostgreSQL
```bash
railway add postgresql
```

Railway will automatically set the `DATABASE_URL` environment variable.

### Docker Deployment

#### Dockerfile
```dockerfile
FROM node:18-alpine AS base

# Install dependencies only when needed
FROM base AS deps
RUN apk add --no-cache libc6-compat
WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm ci --only=production

# Rebuild the source code only when needed
FROM base AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .

RUN npm run build

# Production image, copy all the files and run next
FROM base AS runner
WORKDIR /app

ENV NODE_ENV=production

RUN addgroup --system --gid 1001 nodejs
RUN adduser --system --uid 1001 nextjs

COPY --from=builder /app/public ./public
COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static

USER nextjs

EXPOSE 3000

ENV PORT=3000
ENV HOSTNAME="0.0.0.0"

CMD ["node", "server.js"]
```

#### docker-compose.yml
```yaml
version: '3.8'
services:
  app:
    build: .
    ports:
      - "3000:3000"
    environment:
      - DATABASE_URL=postgresql://postgres:password@db:5432/kolaybase
      - JWT_SECRET=your-jwt-secret-here
    depends_on:
      - db

  db:
    image: postgres:15
    environment:
      - POSTGRES_DB=kolaybase
      - POSTGRES_USER=postgres
      - POSTGRES_PASSWORD=password
    volumes:
      - postgres_data:/var/lib/postgresql/data
    ports:
      - "5432:5432"

volumes:
  postgres_data:
```

#### Deploy with Docker Compose
```bash
docker-compose up -d
```

### AWS (EC2 + RDS)

#### Step 1: Launch EC2 Instance
1. Launch an Ubuntu 20.04 LTS instance
2. Configure security groups to allow HTTP (80), HTTPS (443), and SSH (22)

#### Step 2: Set up RDS PostgreSQL
1. Create a PostgreSQL RDS instance
2. Note the connection string

#### Step 3: Deploy Application
```bash
# SSH into your EC2 instance
ssh -i your-key.pem ubuntu@your-ec2-ip

# Install Node.js and PM2
curl -fsSL https://deb.nodesource.com/setup_18.x | sudo -E bash -
sudo apt-get install -y nodejs
sudo npm install -g pm2

# Clone and setup your application
git clone https://github.com/your-username/kolaybase.git
cd kolaybase
npm install
npm run build

# Create environment file
cat > .env << EOF
DATABASE_URL=your-rds-connection-string
JWT_SECRET=your-jwt-secret
NODE_ENV=production
EOF

# Start with PM2
pm2 start npm --name kolaybase -- start
pm2 save
pm2 startup
```

#### Step 4: Set up Nginx (Optional)
```bash
sudo apt update
sudo apt install nginx

# Create Nginx configuration
sudo cat > /etc/nginx/sites-available/kolaybase << 'EOF'
server {
    listen 80;
    server_name your-domain.com;

    location / {
        proxy_pass http://localhost:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_cache_bypass $http_upgrade;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
EOF

sudo ln -s /etc/nginx/sites-available/kolaybase /etc/nginx/sites-enabled/
sudo nginx -t
sudo systemctl restart nginx
```

## Database Setup

### Initial Migration
After deployment, run the database setup:

```bash
# If using npm scripts
npm run db:setup

# Or directly with Node.js
node scripts/setup-db.js
```

### Production Database Considerations

#### Connection Pooling
For production, consider using connection pooling:

```env
# Add to your environment variables
DATABASE_URL=postgresql://username:password@host:5432/database?pgbouncer=true
```

#### Read Replicas
For high-traffic applications, consider read replicas:

```env
DATABASE_READ_URL=postgresql://username:password@read-replica-host:5432/database
```

#### Backup Strategy
Set up automated backups:
- **Neon**: Automatic backups included
- **AWS RDS**: Enable automated backups
- **Self-hosted**: Set up pg_dump cron jobs

## SSL/TLS Configuration

### Let's Encrypt (Free SSL)
```bash
# Install Certbot
sudo apt install certbot python3-certbot-nginx

# Get certificate
sudo certbot --nginx -d your-domain.com

# Auto-renewal
sudo crontab -e
# Add: 0 12 * * * /usr/bin/certbot renew --quiet
```

### Environment-specific SSL
```env
# Force HTTPS in production
FORCE_HTTPS=true
```

## Performance Optimization

### Next.js Configuration
Update `next.config.mjs`:
```javascript
/** @type {import('next').NextConfig} */
const nextConfig = {
  output: 'standalone',
  compress: true,
  poweredByHeader: false,
  reactStrictMode: true,
  swcMinify: true,
  images: {
    domains: ['your-domain.com'],
    formats: ['image/webp', 'image/avif'],
  },
  experimental: {
    serverComponentsExternalPackages: ['@neondatabase/serverless'],
  },
}

export default nextConfig
```

### Caching Strategy
Implement Redis for session storage and caching:
```env
REDIS_URL=redis://localhost:6379
```

## Monitoring and Logging

### Health Check Endpoint
The application includes a health check at `/api/health`:

```bash
curl https://your-domain.com/api/health
```

### Application Monitoring
Consider integrating:
- **Sentry** for error tracking
- **DataDog** or **New Relic** for APM
- **LogRocket** for user session recording

### Database Monitoring
Monitor your database performance:
- **Neon**: Built-in monitoring dashboard
- **AWS RDS**: CloudWatch metrics
- **Self-hosted**: pg_stat_statements extension

## Security Considerations

### Environment Security
```bash
# Set proper file permissions
chmod 600 .env
```

### CORS Configuration
```env
ALLOWED_ORIGINS=https://your-frontend-domain.com
```

### Rate Limiting
Configure appropriate rate limits:
```env
RATE_LIMIT_REQUESTS=1000
RATE_LIMIT_WINDOW=60000
```

### API Key Security
- Rotate API keys regularly
- Use scoped permissions
- Monitor API key usage

## Troubleshooting

### Common Issues

#### Database Connection
```bash
# Test database connection
psql $DATABASE_URL -c "SELECT version();"
```

#### Environment Variables
```bash
# Check if variables are loaded
node -e "console.log(process.env.DATABASE_URL)"
```

#### Build Issues
```bash
# Clear Next.js cache
rm -rf .next
npm run build
```

#### Memory Issues
```bash
# Increase Node.js memory limit
export NODE_OPTIONS="--max-old-space-size=4096"
```

### Logs
```bash
# View PM2 logs
pm2 logs kolaybase

# View system logs
sudo journalctl -f -u nginx
```

## Scaling Considerations

### Horizontal Scaling
- Use multiple server instances behind a load balancer
- Implement session storage in Redis
- Use CDN for static assets

### Database Scaling
- Implement read replicas
- Use connection pooling
- Consider database partitioning for large datasets

### Caching
- Implement Redis for session and data caching
- Use CDN for static assets
- Enable Next.js ISR (Incremental Static Regeneration)

## Backup and Recovery

### Database Backups
```bash
# Create backup
pg_dump $DATABASE_URL > backup.sql

# Restore backup
psql $DATABASE_URL < backup.sql
```

### Application Backups
- Store code in version control (Git)
- Backup environment configurations
- Document deployment procedures

### Disaster Recovery
1. Keep regular database backups
2. Document all environment variables
3. Maintain deployment scripts
4. Test recovery procedures regularly