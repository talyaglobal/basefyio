# Quick Start: Deploy to Vercel

## 🚀 Fast Deployment (5 minutes)

### 1. Prepare Database
- Create a Neon PostgreSQL database at [neon.tech](https://neon.tech)
- Copy your connection string

### 2. Deploy to Vercel

**Via Dashboard:**
1. Go to [vercel.com/new](https://vercel.com/new)
2. Import your Git repository
3. Framework: **Next.js** (auto-detected)
4. Add environment variables (see below)
5. Click **Deploy**

**Via CLI:**
```bash
npm i -g vercel
vercel login
vercel
```

### 3. Set Environment Variables

In Vercel Dashboard → Settings → Environment Variables, add:

**Minimum Required:**
```env
DATABASE_URL=postgresql://user:pass@host/db?sslmode=require
JWT_SECRET=<generate-32-char-secret>
NEXT_PUBLIC_BASE_URL=https://your-app.vercel.app
```

**Generate secrets:**
```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

### 4. Initialize Database

After first deployment, run:
```bash
export DATABASE_URL="your-production-url"
npm run db:setup
```

Or use Neon SQL Editor with `scripts/init-db.sql`

### 5. Access Your App

- Production URL: `https://your-project.vercel.app`
- Default login: `admin@kolaybase.com` / `admin123`
- ⚠️ Change password immediately!

## 📋 Files Created

- ✅ `vercel.json` - Deployment configuration
- ✅ `.vercelignore` - Files to exclude from deployment
- ✅ `DEPLOYMENT.md` - Full deployment guide
- ✅ `VERCEL_ENV_VARS.md` - Environment variables reference

## ⚙️ Configuration

The `vercel.json` file configures:
- Function timeouts (30-300s depending on route)
- Security headers
- API route rewrites
- Regional deployment (iad1)

## 🔧 Troubleshooting

**Build fails?**
- Check environment variables are set
- Verify `DATABASE_URL` includes `?sslmode=require`
- Review build logs in Vercel dashboard

**Can't connect to database?**
- Verify connection string format
- Check Neon connection pooling settings
- Ensure SSL is enabled

**Authentication not working?**
- Verify `JWT_SECRET` is set
- Check `NEXT_PUBLIC_BASE_URL` matches deployment URL
- Clear cookies and try again

## 📚 Full Documentation

See `DEPLOYMENT.md` for complete deployment guide.

