# basefyio-cli

The command-line tool for [basefyio](https://basefyio.com): manage projects, run SQL and
migrations, generate types and take backups from your terminal. Installs two equivalent
commands, `basefyio` and `bf`.

```bash
npm install -g basefyio-cli
basefyio login                      # opens the browser to sign in
basefyio link --project-id <id>     # links this folder and writes the project's settings to .env
basefyio status
```

## Commands

| Area | Commands |
|---|---|
| Account | `login`, `logout`, `upgrade` |
| Projects | `init`, `link`, `unlink`, `status`, `projects`, `projects:create`, `projects:delete` |
| Database | `db push`, `db pull`, `db reset`, `db seed`, `db dump`, `db diff`, `db execute`, `db rotate-password`, `push`, `inspect` |
| Vectors | `pgvector status`, `pgvector enable`, `pgvector disable` |
| Code generation | `gen types`, `gen client` |
| Migrations | `migration new`, `migration up`, `migration down`, `migration status` |
| Backups | `backup create`, `backup list`, `backup status`, `backup download`, `backup restore` |
| Other | `logs`, `secrets list`, `secrets set`, `secrets unset` |

Run `basefyio <command> --help` for the options of each command.

## Documentation

- CLI reference: <https://basefyio.com/docs/cli>
- Quickstart: <https://basefyio.com/docs/quickstart>
- Source and issues: <https://github.com/talyaglobal/basefyio>

## License

MIT
