# Contributing to Kolaybase

Thank you for your interest in contributing to Kolaybase! This document provides guidelines and information for contributors.

## Table of Contents

- [Code of Conduct](#code-of-conduct)
- [Getting Started](#getting-started)
- [Development Setup](#development-setup)
- [Contributing Process](#contributing-process)
- [Coding Standards](#coding-standards)
- [Testing](#testing)
- [Documentation](#documentation)
- [Security](#security)

## Code of Conduct

By participating in this project, you agree to abide by our Code of Conduct:

- **Be respectful**: Treat all community members with respect
- **Be inclusive**: Welcome newcomers and help them learn
- **Be constructive**: Provide helpful feedback and suggestions
- **Be patient**: Remember that everyone was a beginner once

## Getting Started

### Prerequisites

- Node.js 18+ 
- npm or yarn
- PostgreSQL database (local or cloud)
- Git

### Development Setup

1. **Fork and Clone**
   ```bash
   git clone https://github.com/your-username/kolaybase.git
   cd kolaybase
   ```

2. **Install Dependencies**
   ```bash
   npm install
   ```

3. **Set Up Environment**
   ```bash
   cp .env.example .env
   ```
   
   Edit `.env` with your database connection:
   ```env
   DATABASE_URL=postgresql://username:password@host:5432/database
   JWT_SECRET=your_super_secret_jwt_key_here
   ```

4. **Initialize Database**
   ```bash
   npm run db:setup
   ```

5. **Start Development Server**
   ```bash
   npm run dev
   ```

6. **Verify Setup**
   - Open [http://localhost:3000](http://localhost:3000)
   - Sign in with: admin@kolaybase.com / admin123

## Contributing Process

### 1. Choose an Issue

- Check the [Issues](https://github.com/your-username/kolaybase/issues) page
- Look for issues labeled `good first issue` for beginners
- Comment on the issue to let others know you're working on it

### 2. Create a Branch

```bash
git checkout -b feature/your-feature-name
# or
git checkout -b fix/your-bug-fix
```

### 3. Make Your Changes

- Write clean, readable code
- Follow the existing code style
- Add tests for new functionality
- Update documentation as needed

### 4. Test Your Changes

```bash
# Run linting
npm run lint

# Run type checking
npm run type-check

# Test the application manually
npm run dev
```

### 5. Commit Your Changes

Use conventional commit messages:

```bash
# Features
git commit -m "feat: add real-time notifications"

# Bug fixes
git commit -m "fix: resolve authentication token expiry"

# Documentation
git commit -m "docs: update API documentation"

# Refactoring
git commit -m "refactor: improve database connection handling"
```

### 6. Push and Create Pull Request

```bash
git push origin your-branch-name
```

Create a Pull Request with:
- Clear title and description
- Reference to related issues
- Screenshots for UI changes
- Test instructions

## Coding Standards

### TypeScript

- Use TypeScript for all new code
- Define proper types and interfaces
- Avoid `any` type unless absolutely necessary

```typescript
// Good
interface User {
  id: number;
  email: string;
  name?: string;
}

// Avoid
const user: any = { id: 1, email: "test@example.com" };
```

### React Components

- Use functional components with hooks
- Follow naming conventions
- Keep components small and focused

```tsx
// Good
interface ButtonProps {
  children: React.ReactNode;
  onClick: () => void;
  variant?: 'primary' | 'secondary';
}

export function Button({ children, onClick, variant = 'primary' }: ButtonProps) {
  return (
    <button 
      className={`btn btn-${variant}`}
      onClick={onClick}
    >
      {children}
    </button>
  );
}
```

### API Routes

- Use proper HTTP methods and status codes
- Implement proper error handling
- Add input validation

```typescript
export async function POST(request: Request) {
  try {
    const body = await request.json();
    
    // Validate input
    const { email, password } = SignInSchema.parse(body);
    
    // Business logic
    const user = await authenticateUser(email, password);
    
    return NextResponse.json({ user }, { status: 200 });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return NextResponse.json(
        { error: 'Validation failed', details: error.errors },
        { status: 400 }
      );
    }
    
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    );
  }
}
```

### Database Queries

- Use parameterized queries to prevent SQL injection
- Handle errors appropriately
- Use transactions for multiple operations

```typescript
// Good
const result = await client.query(
  'SELECT * FROM users WHERE email = $1',
  [email]
);

// Avoid
const result = await client.query(
  `SELECT * FROM users WHERE email = '${email}'`
);
```

### File Organization

```
kolaybase/
├── app/                    # Next.js app directory
│   ├── api/               # API routes
│   ├── (auth)/            # Auth pages
│   └── dashboard/         # Dashboard pages
├── components/            # React components
│   ├── ui/               # Base UI components
│   └── forms/            # Form components
├── lib/                   # Utilities and configurations
│   ├── auth.ts           # Authentication logic
│   ├── db.ts             # Database utilities
│   └── utils.ts          # General utilities
├── types/                 # TypeScript type definitions
├── docs/                  # Documentation
└── scripts/               # Database and build scripts
```

## Testing

### Manual Testing

Before submitting a PR, test:

1. **Authentication Flow**
   - Sign up, sign in, sign out
   - API key creation and usage

2. **Core Features**
   - Database table management
   - SQL query execution  
   - File upload/download
   - Real-time subscriptions

3. **Error Handling**
   - Invalid inputs
   - Network failures
   - Database errors

### Writing Tests (Future)

We plan to add automated testing. When implemented:

```typescript
// Example unit test
describe('AuthService', () => {
  it('should validate JWT tokens', () => {
    const token = generateToken({ userId: 1 });
    const decoded = validateToken(token);
    expect(decoded.userId).toBe(1);
  });
});

// Example integration test
describe('API: /api/tables', () => {
  it('should return list of tables', async () => {
    const response = await fetch('/api/tables', {
      headers: { Authorization: `Bearer ${apiKey}` }
    });
    
    expect(response.status).toBe(200);
    const data = await response.json();
    expect(Array.isArray(data.tables)).toBe(true);
  });
});
```

## Documentation

### Code Documentation

- Add JSDoc comments for functions and classes
- Document complex business logic
- Include examples for utility functions

```typescript
/**
 * Generates a scoped API key for the given user
 * @param userId - The ID of the user
 * @param scopes - Array of permission scopes
 * @param expiresAt - Optional expiration date
 * @returns Promise resolving to the API key object
 * 
 * @example
 * const apiKey = await generateApiKey(1, ['read:tables'], new Date('2024-12-31'));
 */
export async function generateApiKey(
  userId: number, 
  scopes: string[], 
  expiresAt?: Date
): Promise<ApiKey> {
  // Implementation
}
```

### API Documentation

- Update `docs/api.md` for API changes
- Include request/response examples
- Document error codes and messages

### README Updates

- Update feature list for new capabilities
- Add setup instructions for new dependencies
- Update screenshots for UI changes

## Security

### Security Best Practices

- Never commit secrets or API keys
- Use environment variables for configuration
- Validate all user inputs
- Implement proper authentication and authorization
- Use HTTPS in production

### Reporting Security Issues

For security-related issues:

1. **DO NOT** create a public GitHub issue
2. Email security concerns to: security@kolaybase.com
3. Include detailed reproduction steps
4. Allow time for response before public disclosure

## Pull Request Guidelines

### PR Title Format

```
type(scope): description

Examples:
feat(auth): add magic link authentication
fix(api): resolve rate limiting issue
docs(readme): update installation instructions
refactor(db): improve connection pooling
```

### PR Description Template

```markdown
## Description
Brief description of changes

## Type of Change
- [ ] Bug fix (non-breaking change that fixes an issue)
- [ ] New feature (non-breaking change that adds functionality)
- [ ] Breaking change (fix or feature that causes existing functionality to not work as expected)
- [ ] Documentation update

## Testing
- [ ] Manual testing completed
- [ ] All existing functionality still works
- [ ] New functionality works as expected

## Screenshots (if applicable)
Add screenshots for UI changes

## Related Issues
Closes #123
```

### Review Process

1. All PRs require at least one review
2. Address feedback constructively
3. Update code based on review comments
4. Maintainers will merge approved PRs

## Release Process

### Versioning

We follow [Semantic Versioning](https://semver.org/):

- **MAJOR**: Breaking changes
- **MINOR**: New features (backwards compatible)
- **PATCH**: Bug fixes (backwards compatible)

### Release Notes

- Document all user-facing changes
- Include migration instructions for breaking changes
- Credit contributors

## Community

### Getting Help

- **GitHub Discussions**: For questions and general discussion
- **GitHub Issues**: For bug reports and feature requests
- **Documentation**: Check `docs/` directory first

### Recognition

Contributors are recognized in:
- Release notes
- Contributors section in README
- Special mentions for significant contributions

## Development Tips

### Useful Commands

```bash
# Development
npm run dev              # Start dev server
npm run build           # Build for production
npm run start           # Start production server

# Quality
npm run lint            # Run ESLint
npm run type-check      # Run TypeScript compiler
npm run format          # Format code with Prettier

# Database
npm run db:setup        # Initialize database
npm run db:reset        # Reset database (destructive!)
```

### Common Issues

1. **Database Connection Errors**
   - Verify `DATABASE_URL` is correct
   - Check if PostgreSQL is running
   - Ensure database exists

2. **Build Errors**
   - Clear `.next` cache: `rm -rf .next`
   - Reinstall dependencies: `rm -rf node_modules && npm install`

3. **Type Errors**
   - Run `npm run type-check` to see detailed errors
   - Check import statements and type definitions

### IDE Setup

#### VS Code Extensions

Recommended extensions:
- TypeScript and JavaScript Language Features
- ESLint
- Prettier - Code formatter
- Tailwind CSS IntelliSense
- GitLens

#### VS Code Settings

```json
{
  "editor.formatOnSave": true,
  "editor.codeActionsOnSave": {
    "source.fixAll.eslint": true
  },
  "typescript.preferences.importModuleSpecifier": "relative"
}
```

## Questions?

If you have questions about contributing, feel free to:

1. Check existing documentation in `docs/`
2. Search through GitHub Issues
3. Create a new Discussion thread
4. Reach out to maintainers

Thank you for contributing to Kolaybase! 🚀