# Kolaykey Quick Start Guide

Get your Kolaykey project up and running in minutes!

## 🚀 Quick Setup (3 Steps)

### Step 1: Create Environment File

```bash
cp .env.kolaykey.example .env.kolaykey
```

### Step 2: Configure Database

Edit `.env.kolaykey` and add your PostgreSQL connection string:

```env
DATABASE_URL=postgresql://username:password@host:5432/kolaykey
```

**Need a database?** 
- 🆓 [Neon](https://neon.tech) - Free PostgreSQL (recommended)
- 🆓 [Supabase](https://supabase.com) - Free PostgreSQL
- 💻 Local - Install PostgreSQL locally

### Step 3: Initialize Database

```bash
npm run db:setup:kolaykey
```

That's it! 🎉 Your database is ready.

## 🏃 Start the Application

```bash
npm run dev
```

Visit [http://localhost:3000](http://localhost:3000)

## 🔐 Default Login

- **Email**: `admin@kolaybase.com`
- **Password**: `admin123`

⚠️ **Important**: Change the password immediately after first login!

## 📚 Next Steps

- Read the full [KOLAYKEY_SETUP.md](./KOLAYKEY_SETUP.md) guide
- Check [API documentation](./docs/api.md)
- Review [deployment guide](./docs/deployment.md)

## 🆘 Need Help?

- Check [troubleshooting section](./KOLAYKEY_SETUP.md#troubleshooting)
- Review the main [README.md](./README.md)

