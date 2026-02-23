# Kolaybase CLI - Quick Reference

## Installation

```bash
npm install -g @kolaybase/cli
```

## Essential Commands

| Command | Description |
|---------|-------------|
| `kb login` | Login to Kolaybase |
| `kb init` | Initialize new project |
| `kb start` | Start local environment |
| `kb stop` | Stop local environment |
| `kb status` | Show service status |
| `kb projects` | List all projects |
| `kb db push` | Push schema to database |
| `kb db pull` | Pull schema from database |
| `kb gen types` | Generate TypeScript types |
| `kb logs` | View logs |

## Common Workflows

### Start a New Project

```bash
kb login
kb init --name "My App"
kb start
kb gen types
```

### Database Migration

```bash
# Edit schema.prisma or SQL files
kb db push
kb gen types
git commit -am "Update schema"
```

### View Logs

```bash
kb logs --follow           # Container logs
kb logs --sql --follow     # SQL audit logs
```

### Manage Secrets

```bash
kb secrets list
kb secrets set API_KEY value
kb secrets unset API_KEY
```

## Tips

- Use `kb` or `kolaybase` (both work)
- Add `--help` to any command for details
- Most commands auto-detect your project
- Use `kb status` to check health

## Getting Help

```bash
kb --help                  # List all commands
kb <command> --help        # Command-specific help
```

## File Locations

- Config: `~/.config/kolaybase/config.json`
- Project: `.kolaybase/config.json`
- Environment: `.env`

## Quick Troubleshooting

| Issue | Solution |
|-------|----------|
| "Docker not running" | Start Docker Desktop |
| "Not logged in" | Run `kb login` |
| "Not in project" | Run `kb init` or `kb link` |
| "Port in use" | Change port in .env or stop other services |

---

For full documentation, see [README.md](./README.md)
