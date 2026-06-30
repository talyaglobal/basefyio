# basefyio CLI - Quick Reference

## Installation

```bash
npm install -g basefyio-cli
```

## Essential Commands

| Command | Description |
|---------|-------------|
| `basefyio login` | Login to basefyio |
| `basefyio init` | Initialize new project |
| `basefyio start` | Start local environment |
| `basefyio stop` | Stop local environment |
| `basefyio status` | Show service status |
| `basefyio projects` | List all projects |
| `basefyio db push` | Push schema to database |
| `basefyio db pull` | Pull schema from database |
| `basefyio gen types` | Generate TypeScript types |
| `basefyio logs` | View logs |

## Common Workflows

### Start a New Project

```bash
basefyio login
basefyio init --name "My App"
basefyio start
basefyio gen types
```

### Database Migration

```bash
# Edit schema.prisma or SQL files
basefyio db push
basefyio gen types
git commit -am "Update schema"
```

### View Logs

```bash
basefyio logs --follow           # Container logs
basefyio logs --sql --follow     # SQL audit logs
```

### Manage Secrets

```bash
basefyio secrets list
basefyio secrets set API_KEY value
basefyio secrets unset API_KEY
```

## Tips

- Use `basefyio` command
- Add `--help` to any command for details
- Most commands auto-detect your project
- Use `basefyio status` to check health

## Getting Help

```bash
basefyio --help                  # List all commands
basefyio <command> --help        # Command-specific help
```

## File Locations

- Config: `~/.config/basefyio/config.json`
- Project: `.basefyio/config.json`
- Environment: `.env`

## Quick Troubleshooting

| Issue | Solution |
|-------|----------|
| "Docker not running" | Start Docker Desktop |
| "Not logged in" | Run `basefyio login` |
| "Not in project" | Run `basefyio init` or `basefyio link` |
| "Port in use" | Change port in .env or stop other services |

---

For full documentation, see [README.md](./README.md)
