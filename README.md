# Kolaybase

A powerful database management interface inspired by Supabase, built with Next.js 16 and Neon PostgreSQL.

## Features

- **Authentication System**: Secure user authentication with JWT tokens
- **Table Editor**: Browse and edit database tables with an intuitive data grid
- **SQL Editor**: Write and execute SQL queries with syntax highlighting
- **GraphQL Explorer**: Test GraphQL queries and explore your API schema
- **Realtime Testing**: Test realtime subscriptions and connections
- **Storage Browser**: Manage file uploads and storage
- **API Key Management**: Create and manage API keys for programmatic access
- **Settings**: Comprehensive account and database settings

## Tech Stack

- **Framework**: Next.js 16 with App Router
- **Database**: Neon PostgreSQL
- **Authentication**: JWT with bcryptjs
- **UI**: shadcn/ui components with Tailwind CSS v4
- **Deployment**: Vercel

## Getting Started

### Prerequisites

- Node.js 18+ installed
- A Neon database account

### Installation

1. Clone the repository
2. Install dependencies:
   \`\`\`bash
   npm install
   \`\`\`

3. Set up environment variables:
   \`\`\`env
   DATABASE_URL=your_neon_database_url
   JWT_SECRET=your_jwt_secret
   \`\`\`

4. Run the database migrations:
   \`\`\`bash
   # The SQL scripts in /scripts will set up your database
   \`\`\`

5. Start the development server:
   \`\`\`bash
   npm run dev
   \`\`\`

6. Open [http://localhost:3000](http://localhost:3000)

## Database Schema

The application uses the following tables:
- `users` - User accounts
- `api_keys` - API key management
- `storage_files` - File storage metadata
- `saved_queries` - Saved SQL queries

## API Routes

- `/api/auth/*` - Authentication endpoints
- `/api/tables/*` - Table management
- `/api/sql/*` - SQL query execution
- `/api/graphql` - GraphQL endpoint
- `/api/storage/*` - File storage
- `/api/api-keys/*` - API key management
- `/api/settings/*` - User settings

## Features in Detail

### Table Editor
- View all tables in your database
- Browse table data with pagination
- Edit rows inline
- Add new rows
- Delete rows
- Search across table data

### SQL Editor
- Write SQL queries with a code editor
- Execute queries and view results
- Save frequently used queries
- Export results to CSV
- View execution time

### GraphQL Explorer
- Execute GraphQL queries and mutations
- Test with variables
- View schema documentation
- Realtime subscription testing

### Storage Browser
- Upload files with progress tracking
- Browse uploaded files
- Download files
- Delete files
- Search files

### API Keys
- Generate secure API keys
- View and copy keys
- Delete keys
- Usage examples for REST and JavaScript

## Security

- Passwords are hashed with bcrypt
- JWT tokens for authentication
- HTTP-only cookies
- Protected API routes
- Row-level security ready

## License

MIT

## Contributing

Contributions are welcome! Please feel free to submit a Pull Request.
