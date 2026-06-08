# Contributing to Basefyio CLI

Thank you for your interest in contributing to Basefyio CLI!

## Development Setup

### Prerequisites

- Node.js 20+
- npm or pnpm
- Git

### Setup

```bash
# Clone the repository
git clone https://github.com/fsipka/basefyio-new.git
cd v0-basefyio/packages/cli

# Install dependencies
npm install

# Build the CLI
npm run build

# Link for local development
npm link
```

### Development Workflow

```bash
# Watch mode (rebuilds on changes)
npm run dev

# Test your changes
basefyio --version
basefyio <command>

# Unlink when done
npm unlink -g basefyio-cli
```

## Project Structure

```
packages/cli/
├── src/
│   ├── index.ts              # Main entry point, command definitions
│   ├── commands/             # Command implementations
│   │   ├── login.ts
│   │   ├── init.ts
│   │   ├── projects.ts
│   │   ├── start.ts
│   │   ├── stop.ts
│   │   ├── status.ts
│   │   ├── db.ts
│   │   ├── gen.ts
│   │   ├── logs.ts
│   │   ├── secrets.ts
│   │   └── link.ts
│   └── lib/                  # Shared utilities
│       ├── api.ts            # API client
│       ├── config.ts         # Configuration management
│       └── ui.ts             # Terminal UI helpers
├── README.md
├── CHANGELOG.md
├── package.json
└── tsconfig.json
```

## Adding a New Command

### 1. Create command file

```typescript
// src/commands/mycommand.ts
import chalk from 'chalk';
import { success, error, createSpinner } from '../lib/ui.js';
import { apiClient, handleApiError } from '../lib/api.js';

export async function myCommand(options: any) {
  console.log(chalk.bold.cyan('My Command\n'));
  
  const spinner = createSpinner('Doing something...');
  
  try {
    // Your command logic here
    const result = await apiClient.doSomething();
    
    spinner.succeed('Done!');
    success('Command completed successfully');
  } catch (err) {
    spinner.fail('Command failed');
    handleApiError(err);
  }
}
```

### 2. Register command

```typescript
// src/index.ts
import { myCommand } from './commands/mycommand.js';

program
  .command('mycommand')
  .description('Description of my command')
  .option('-o, --option <value>', 'Some option')
  .action(myCommand);
```

### 3. Add tests (when testing is set up)

```typescript
// tests/commands/mycommand.test.ts
describe('mycommand', () => {
  it('should do something', async () => {
    // Test implementation
  });
});
```

## Code Style

### TypeScript

- Use TypeScript strict mode
- Define interfaces for all data structures
- Use async/await over promises
- Use ESM imports

### Formatting

- Use 2 spaces for indentation
- Use single quotes for strings
- Add trailing commas
- No semicolons (except where required)

### Error Handling

Always provide helpful error messages:

```typescript
try {
  // operation
} catch (err) {
  if (err.code === 'SPECIFIC_ERROR') {
    error('Specific helpful message');
    console.log(chalk.gray('Suggestion on how to fix'));
  } else {
    handleApiError(err);
  }
}
```

### UI Guidelines

Use consistent UI patterns:

```typescript
import { success, error, warning, info, createSpinner, printTable } from '../lib/ui.js';

// For operations
const spinner = createSpinner('Loading...');
// ... operation
spinner.succeed('Success');

// For messages
success('Operation completed');
error('Something went wrong');
warning('Be careful');
info('FYI: some information');

// For data
printTable(['Header1', 'Header2'], [
  ['Value1', 'Value2'],
  ['Value3', 'Value4'],
]);
```

## Testing

```bash
# Run tests (when available)
npm test

# Run tests in watch mode
npm test -- --watch

# Run specific test
npm test mycommand.test.ts
```

## Documentation

### Update README

When adding a new command, update:
- Command list
- Usage examples
- Configuration options (if any)

### Update CHANGELOG

Add entry under `[Unreleased]`:

```markdown
### Added
- New command: `basefyio mycommand` - does something useful
```

### Add Examples

Add practical examples to `EXAMPLES.md`:

```markdown
### My Command Workflow

\`\`\`bash
# Step 1
basefyio mycommand --option value

# Step 2
basefyio another-command
\`\`\`
```

## Pull Request Process

1. **Fork the repository**

2. **Create a feature branch**
   ```bash
   git checkout -b feature/my-new-command
   ```

3. **Make your changes**
   - Write code
   - Add tests (if applicable)
   - Update documentation

4. **Test thoroughly**
   ```bash
   npm run build
   npm link
   basefyio mycommand  # Test your changes
   ```

5. **Commit with clear message**
   ```bash
   git commit -m "feat: add mycommand for doing X"
   ```

6. **Push and create PR**
   ```bash
   git push origin feature/my-new-command
   ```

7. **Describe your changes**
   - What does this PR do?
   - Why is this change needed?
   - How to test it?

## Commit Message Format

Use conventional commits:

- `feat:` New feature
- `fix:` Bug fix
- `docs:` Documentation changes
- `style:` Code style changes (formatting)
- `refactor:` Code refactoring
- `test:` Adding tests
- `chore:` Maintenance tasks

Examples:
```
feat: add db backup command
fix: handle connection timeout in start command
docs: update README with new examples
refactor: simplify config management
```

## API Client

When adding API calls:

```typescript
// Add method to src/lib/api.ts
export class ApiClient {
  async myNewMethod(param: string) {
    const { data } = await this.client.post('/my-endpoint', { param });
    return data;
  }
}

// Use in command
import { apiClient } from '../lib/api.js';

const result = await apiClient.myNewMethod('value');
```

## Configuration

When adding config values:

```typescript
// Update src/lib/config.ts
export interface UserConfig {
  // ... existing fields
  myNewField?: string;
}

export function getMyNewField(): string | undefined {
  return userConfig.get('myNewField');
}
```

## Questions?

- Open an issue for bugs or feature requests
- Start a discussion for questions
- Check existing issues and PRs first

## Code of Conduct

- Be respectful and inclusive
- Provide constructive feedback
- Help others learn and grow

Thank you for contributing! 🎉
