# Changelog

All notable changes to the basefyio CLI will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.0] - 2026-02-23

### Added
- Initial release of basefyio CLI
- Authentication commands (`login`)
- Project management commands (`init`, `projects`, `link`)
- Local development commands (`start`, `stop`, `status`)
- Database management commands (`db push`, `db pull`, `db reset`, `db seed`, `db diff`)
- Code generation commands (`gen types`, `gen client`)
- Logging commands (`logs`)
- Secrets management commands (`secrets list`, `secrets set`, `secrets unset`)
- Support for TypeScript, JavaScript, and Python client generation
- Docker Compose integration for local development
- Automatic token refresh on authentication
- Configuration management (global and project-specific)
- Environment variable management
- Interactive prompts for user-friendly experience
- Colored terminal output with spinners and progress indicators
- Comprehensive documentation and examples

### Features
- 🔐 Secure authentication with JWT tokens
- 📦 Project initialization and linking
- 🐳 One-command local environment setup
- 🗄️ Database schema management (Prisma and raw SQL support)
- 🔧 TypeScript type generation from database schema
- 📊 Real-time log viewing (containers and SQL audit logs)
- 🔑 Environment secrets management with masking
- 🚀 Multiple language support for client generation
- ⚡ Fast and efficient CLI with modern tooling

### Developer Experience
- Intuitive command structure similar to common hosted Postgres CLIs
- Clear error messages and helpful suggestions
- Auto-detection of project root
- Support for both ESM and CommonJS
- Cross-platform support (Windows, macOS, Linux)

## [Unreleased]

### Planned Features
- Remote deployment commands
- Database backup and restore
- Real-time database migrations viewer
- Project sharing and collaboration commands
- Webhook management
- Edge function deployment
- Storage bucket management
- Analytics and monitoring dashboard
- Plugin system for extensibility
- Shell completion (bash, zsh, fish)
- Configuration profiles for multiple environments
