# Basefyio CLI - Build and Installation Guide

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

Now you can use `basefyio` command globally on your system.

### Test the CLI

```bash
# Check version
basefyio --version

# Show help
basefyio --help

# Try a command
basefyio status
```

### Unlink when done

```bash
npm unlink -g basefyio-cli
```

## Development Workflow

### Watch Mode

For active development, use watch mode to automatically rebuild on changes:

```bash
npm run dev
```

In another terminal, test your changes:

```bash
basefyio <command>
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
- `basefyio login` - Login to platform

### Project Management
- `basefyio init` - Initialize project
- `basefyio projects` - List projects
- `basefyio projects:create` - Create project
- `basefyio projects:delete <id>` - Delete project
- `basefyio link` - Link to project
- `basefyio unlink` - Unlink project

### Development
- `basefyio start` - Start local environment
- `basefyio stop` - Stop environment
- `basefyio status` - Show status

### Database
- `basefyio db push` - Push schema
- `basefyio db pull` - Pull schema
- `basefyio db reset` - Reset database
- `basefyio db seed` - Seed database
- `basefyio db diff` - Show differences

### Code Generation
- `basefyio gen types` - Generate types
- `basefyio gen client` - Generate client

### Monitoring
- `basefyio logs` - View logs
- `basefyio logs --sql` - SQL audit logs

### Secrets
- `basefyio secrets list` - List secrets
- `basefyio secrets set <key> <value>` - Set secret
- `basefyio secrets unset <key>` - Remove secret

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
npm install -g basefyio-cli
basefyio --version
```

## Troubleshooting

### Command not found after linking

```bash
npm unlink -g basefyio-cli
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
