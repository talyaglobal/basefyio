# Kolaybase CLI - Build and Installation Guide

## Quick Start

### Install Dependencies

```bash
cd packages/cli
npm install
```

### Build

```bash
npm run build
```

This creates the `dist/` directory with compiled JavaScript files.

### Link for Local Testing

```bash
npm link
```

Now you can use `kb` command globally on your system.

### Test the CLI

```bash
# Check version
kb --version

# Show help
kb --help

# Try a command
kb status
```

### Unlink when done

```bash
npm unlink -g kolaybase-cli
```

## Development Workflow

### Watch Mode

For active development, use watch mode to automatically rebuild on changes:

```bash
npm run dev
```

In another terminal, test your changes:

```bash
kb <command>
```

### Clean Build

```bash
npm run clean
npm run build
```

## Project Structure

The CLI is built with:
- **Commander.js** - Command-line interface framework
- **Inquirer** - Interactive prompts
- **Chalk** - Terminal colors
- **Ora** - Spinners
- **Axios** - HTTP client
- **Execa** - Process execution
- **Conf** - Configuration management

## Available Commands

### Authentication
- `kb login` - Login to platform

### Project Management
- `kb init` - Initialize project
- `kb projects` - List projects
- `kb projects:create` - Create project
- `kb projects:delete <id>` - Delete project
- `kb link` - Link to project
- `kb unlink` - Unlink project

### Development
- `kb start` - Start local environment
- `kb stop` - Stop environment
- `kb status` - Show status

### Database
- `kb db push` - Push schema
- `kb db pull` - Pull schema
- `kb db reset` - Reset database
- `kb db seed` - Seed database
- `kb db diff` - Show differences

### Code Generation
- `kb gen types` - Generate types
- `kb gen client` - Generate client

### Monitoring
- `kb logs` - View logs
- `kb logs --sql` - SQL audit logs

### Secrets
- `kb secrets list` - List secrets
- `kb secrets set <key> <value>` - Set secret
- `kb secrets unset <key>` - Remove secret

## Publishing (For Maintainers)

### Prepare for Publish

1. Update version in `package.json`
2. Update `CHANGELOG.md`
3. Build and test

```bash
npm run build
npm link
# Test thoroughly
```

### Publish to NPM

```bash
npm login
npm publish --access public
```

### Verify Publication

```bash
npm install -g kolaybase-cli
kb --version
```

## Troubleshooting

### Command not found after linking

```bash
npm unlink -g kolaybase-cli
npm link
```

### TypeScript errors

```bash
npm install
npm run build
```

### Module resolution errors

Make sure `"type": "module"` is in package.json and all imports use `.js` extension.

## Testing Checklist

Before releasing, test these workflows:

- [ ] Login/Authentication
- [ ] Project initialization
- [ ] Project listing
- [ ] Project creation
- [ ] Start/Stop environment
- [ ] Database operations
- [ ] Type generation
- [ ] Client generation (TS, JS, Python)
- [ ] Logs viewing
- [ ] Secrets management
- [ ] Project linking/unlinking

## Development Tips

1. **Use TypeScript strictly** - Catch errors at compile time
2. **Test with real API** - Start the platform and test against it
3. **Handle errors gracefully** - Always provide helpful error messages
4. **Keep commands fast** - Use spinners for long operations
5. **Follow conventions** - Use existing patterns for consistency

## Next Steps

After building and testing:

1. Read [CONTRIBUTING.md](./CONTRIBUTING.md) for contribution guidelines
2. Check [EXAMPLES.md](./EXAMPLES.md) for usage examples
3. See [README.md](./README.md) for complete documentation
