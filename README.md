# Kolaybase

A powerful PostgreSQL database management platform built with Next.js. Kolaybase provides an intuitive interface for managing databases, generating APIs, and real-time updates.

## Features

- 📊 **Database Management** - Create, manage, and query PostgreSQL databases
- 🚀 **API Generation** - Automatically generate REST and GraphQL APIs
- ⚡ **Real-time Subscriptions** - WAL-based realtime with presence & broadcast channels
- 🔐 **Authentication & Authorization** - Secure user management with JWT
- 📂 **File Storage** - Integrated file upload and management
- 🔑 **API Keys** - Generate and manage API keys with scoped permissions
- ⚡ **Edge Functions** - Serverless functions with Deno/Node.js runtime
- 📅 **Scheduled Jobs** - Cron-based job scheduling with webhooks
- 🔒 **Secrets Manager** - Encrypted secrets with fine-grained permissions
- 📈 **Analytics** - Built-in analytics and monitoring

## Quick Start

### Prerequisites

- Node.js 18+ 
- PostgreSQL database (we recommend [Neon](https://neon.tech) for serverless PostgreSQL)

### Installation

1. Clone the repository:
   ```bash
   git clone <repository-url>
   cd kolaybase
   ```

2. Install dependencies:
   ```bash
   npm install
   ```

3. Set up environment variables:
   ```bash
   cp .env.example .env
   ```
   
   Edit `.env` and add your database connection string:
   ```env
   DATABASE_URL=postgresql://username:password@host:5432/database
   JWT_SECRET=your_super_secret_jwt_key_here
   ```

4. Initialize the database:
   ```bash
   npm run db:setup
   ```

5. Start the development server:
   ```bash
   npm run dev
   ```

6. Open [http://localhost:3000](http://localhost:3000) in your browser.

## Database Setup

### Using Neon (Recommended)

1. Create a new project at [neon.tech](https://neon.tech)
2. Copy your connection string to the `DATABASE_URL` in `.env`
3. Run the database setup script:
   ```bash
   npm run db:setup
   ```

### Using Local PostgreSQL

1. Install PostgreSQL locally
2. Create a new database: `createdb kolaybase`
3. Update `DATABASE_URL` in `.env` with your local connection string
4. Run the setup script: `npm run db:setup`

## Default Credentials

After running the database setup, a default admin user is created:

- **Email**: admin@kolaybase.com  
- **Password**: admin123

⚠️ **Important**: Change this password in production!

## Project Structure

```
kolaybase/
├── app/                    # Next.js 13+ app directory
│   ├── api/               # API routes
│   ├── (auth)/            # Authentication pages
│   └── dashboard/         # Dashboard pages
├── components/            # React components
│   └── ui/               # shadcn/ui components
├── lib/                   # Utility libraries
│   ├── auth.ts           # Authentication logic
│   ├── kolaybase.ts      # Main SDK client
│   └── api-utils.ts      # API utilities
├── scripts/               # Database and utility scripts
│   ├── init-db.sql       # Database schema
│   └── setup-db.js       # Setup script
├── types/                 # TypeScript type definitions
└── public/               # Static assets
```

## API Documentation

Once running, visit `/api-docs` for the OpenAPI documentation.

### Authentication

Kolaybase supports two authentication methods:

1. **Session-based**: Traditional login with JWT tokens
2. **API Keys**: For programmatic access with scoped permissions

### Available Scopes

- `read:tables` - Read table data
- `write:tables` - Modify table data  
- `read:schema` - View database schema
- `write:schema` - Modify database schema
- `read:files` - Access file storage
- `write:files` - Upload/modify files
- `admin` - Full administrative access

## Development

### Available Scripts

- `npm run dev` - Start development server
- `npm run build` - Build for production
- `npm run start` - Start production server
- `npm run lint` - Run ESLint
- `npm run db:setup` - Initialize database
- `npm run db:init` - Alias for db:setup

### Environment Setup

1. **Copy environment template:**
   ```bash
   cp .env.example .env
   ```

2. **Generate secure secrets:**
   ```bash
   node scripts/generate-env-secrets.js
   ```

3. **Update your `.env` file with:**
   - Your PostgreSQL database connection string
   - The generated secure secrets
   - Your application URLs

### Required Environment Variables

| Variable | Description | Required | Default |
|----------|-------------|----------|---------|
| `DATABASE_URL` | PostgreSQL connection string | Yes | - |
| `JWT_SECRET` | Secret for JWT token signing | Yes | - |
| `KOLAYBASE_MASTER_KEY` | Master key for secrets encryption | Recommended | Auto-generated |

### Optional Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `DB_PROVIDER` | Database provider | `neon` |
| `DB_MAX_CONNECTIONS` | Max database connections | `100` |
| `DB_POOL_MAX` | Connection pool size | `20` |
| `REFRESH_SECRET` | Refresh token secret | Uses `JWT_SECRET` |
| `MAGIC_SECRET` | Magic link token secret | Uses `JWT_SECRET` |
| `NEXT_PUBLIC_BASE_URL` | Application base URL | `http://localhost:3000` |
| `GITHUB_CLIENT_ID` | GitHub OAuth client ID | - |
| `GOOGLE_CLIENT_ID` | Google OAuth client ID | - |

## New Features

### 🔄 Real-time Subscriptions
- **WAL-based streaming**: Listen to database changes in real-time
- **Presence tracking**: Track user presence across channels
- **Broadcast messaging**: Send real-time messages to channel subscribers
- **WebSocket connections**: Efficient bidirectional communication

```javascript
// Connect to realtime
const client = kolaybase.realtime.connect()

// Subscribe to table changes
client.subscribe('posts', (change) => {
  console.log('New change:', change)
})

// Join a channel
client.channel('chat-room-1').subscribe()

// Send broadcast message
client.channel('chat-room-1').send('message', { text: 'Hello!' })
```

### ⚡ Edge Functions
- **Multiple runtimes**: Support for Deno and Node.js
- **Function templates**: Pre-built templates for common use cases
- **Environment variables**: Secure configuration management
- **Execution metrics**: Monitor performance and usage

```javascript
// Example edge function (Deno)
export default async function handler(context) {
  const { request, secrets, environment } = context
  
  return new Response(JSON.stringify({
    message: "Hello from Kolaybase Edge Functions!"
  }), {
    headers: { 'Content-Type': 'application/json' }
  })
}
```

### 📅 Scheduled Jobs
- **Cron expressions**: Flexible scheduling with standard cron syntax
- **Multiple triggers**: Support for edge functions and webhooks
- **Timezone support**: Schedule jobs in different timezones
- **Execution history**: Track job runs and performance

```javascript
// Create a scheduled job
await kolaybase.scheduledJobs.create({
  name: 'Daily Report',
  cronExpression: '0 9 * * *', // Every day at 9 AM
  functionId: 'report-generator',
  timezone: 'America/New_York'
})
```

### 🔒 Secrets Manager
- **Encrypted storage**: AES-256-GCM encryption for all secrets
- **Access control**: Fine-grained permissions for users and functions
- **Key rotation**: Built-in key rotation capabilities
- **Audit logging**: Track secret access and modifications

```javascript
// Create a secret
await kolaybase.secrets.create('API_KEY', 'secret-value')

// Grant read access to a function
await kolaybase.secrets.grantPermission('API_KEY', {
  functionId: 'my-function',
  permission: 'read'
})

// Access secret in edge function
const apiKey = context.secrets.API_KEY
```

## Contributing

1. Fork the repository
2. Create a feature branch: `git checkout -b feature/new-feature`
3. Make your changes and add tests
4. Commit your changes: `git commit -am 'Add new feature'`
5. Push to the branch: `git push origin feature/new-feature`
6. Submit a pull request

## License

This project is licensed under the MIT License - see the LICENSE file for details.

## Support

For support and questions:
- Create an issue on GitHub
- Check the documentation at `/api-docs`
- Join our community discussions