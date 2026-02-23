# Kolaybase CLI - Project Overview

## 🎯 What is Kolaybase CLI?

Kolaybase CLI is a command-line interface tool for managing [Kolaybase](https://github.com/yourusername/v0-kolaybase) projects. It provides a developer-friendly way to interact with the Kolaybase platform, similar to how Supabase CLI works for Supabase.

## 🚀 Key Features

- **One-Command Setup**: Initialize and start projects instantly
- **Local Development**: Full local environment with Docker Compose
- **Database Tools**: Push, pull, and manage schemas effortlessly
- **Code Generation**: Auto-generate types and API clients
- **Multi-Language Support**: TypeScript, JavaScript, and Python
- **Real-time Monitoring**: View logs and track SQL queries
- **Secrets Management**: Secure environment variable handling

## 📁 Project Structure

```
packages/cli/
├── src/
│   ├── index.ts              # Main CLI entry point with all command definitions
│   ├── commands/             # Command implementations
│   │   ├── login.ts          # Authentication
│   │   ├── init.ts           # Project initialization
│   │   ├── projects.ts       # Project management
│   │   ├── start.ts          # Start local environment
│   │   ├── stop.ts           # Stop local environment
│   │   ├── status.ts         # Show environment status
│   │   ├── db.ts             # Database operations
│   │   ├── gen.ts            # Code generation
│   │   ├── logs.ts           # Log viewing
│   │   ├── secrets.ts        # Secrets management
│   │   └── link.ts           # Project linking
│   └── lib/                  # Shared utilities
│       ├── api.ts            # API client for platform communication
│       ├── config.ts         # Configuration management (global & project)
│       └── ui.ts             # Terminal UI helpers (colors, spinners, tables)
├── docs/
│   ├── README.md             # Complete documentation
│   ├── QUICK_REFERENCE.md    # Command cheatsheet
│   ├── EXAMPLES.md           # Real-world usage examples
│   ├── BUILD.md              # Build and installation guide
│   ├── CONTRIBUTING.md       # Contribution guidelines
│   ├── CHANGELOG.md          # Version history
│   └── FEATURES.md           # Feature matrix and roadmap
├── package.json              # NPM package configuration
├── tsconfig.json             # TypeScript configuration
├── tsup.config.ts            # Build configuration
├── install.sh                # Installation script
├── demo.sh                   # Demo script
├── .gitignore
└── LICENSE
```

## 🔧 Technical Stack

### Core Technologies
- **TypeScript** - Type-safe development
- **Commander.js** - CLI framework
- **Node.js ESM** - Modern module system

### User Interface
- **Inquirer** - Interactive prompts
- **Chalk** - Terminal colors
- **Ora** - Loading spinners
- **Boxen** - Boxed text display
- **Table** - Formatted tables

### Functionality
- **Axios** - HTTP API client
- **Execa** - Process execution
- **Conf** - Configuration storage
- **pg** - PostgreSQL client
- **dotenv** - Environment variables

### Build Tools
- **tsup** - TypeScript bundler
- **npm** - Package manager

## 📊 Architecture

```
┌─────────────────────────────────────────────────────┐
│                  Kolaybase CLI                      │
│                                                     │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐         │
│  │ Commands │  │   API    │  │  Config  │         │
│  │          │  │  Client  │  │  Manager │         │
│  └────┬─────┘  └────┬─────┘  └────┬─────┘         │
│       │             │             │                │
│       └─────────────┴─────────────┘                │
│                     │                              │
└─────────────────────┼──────────────────────────────┘
                      │
                      ▼
         ┌────────────────────────┐
         │   Platform API         │
         │   (NestJS)             │
         └────────────────────────┘
                      │
         ┌────────────┼────────────┐
         │            │            │
         ▼            ▼            ▼
    PostgreSQL   Keycloak      MinIO
```

## 🎮 Command Flow

### Example: Initialize Project

```
User: kb init --name "My App"
  │
  ├─> Check authentication (config.ts)
  ├─> Prompt for team selection (inquirer)
  ├─> Call API to create project (api.ts)
  ├─> Save project config (config.ts)
  ├─> Generate .env file
  ├─> Create README
  └─> Display success message (ui.ts)
```

### Example: Start Environment

```
User: kb start
  │
  ├─> Detect project root (config.ts)
  ├─> Start Docker Compose (execa)
  ├─> Wait for services to be ready
  ├─> Start Platform API (execa)
  ├─> Start Admin UI (execa)
  └─> Show service URLs (ui.ts)
```

## 📝 Configuration Management

### Global Configuration
```
~/.config/kolaybase/config.json
├── apiUrl
├── accessToken
├── refreshToken
├── userId
├── username
└── email
```

### Project Configuration
```
.kolaybase/config.json
├── projectId
├── projectName
├── projectSlug
├── teamId
└── linkedAt
```

### Environment Variables
```
.env
├── PROJECT_ID
├── DATABASE_URL
├── ANON_KEY
├── SERVICE_KEY
└── (custom vars)
```

## 🔐 Security

- **Token Management**: Secure storage using `conf` package
- **Auto Refresh**: Automatic JWT token refresh
- **Credential Masking**: Sensitive values masked in output
- **.gitignore**: Auto-updates to prevent secret commits
- **HTTPS**: API communication over secure connection

## 🌐 Cross-Platform Support

### Windows
- ✅ PowerShell support
- ✅ Command Prompt support
- ✅ Path resolution

### macOS
- ✅ Terminal support
- ✅ Unix paths
- ✅ Homebrew compatible

### Linux
- ✅ All major distributions
- ✅ Shell scripts
- ✅ Package managers

## 📈 Performance

- **Fast Startup**: ~100ms command execution
- **Efficient API**: Single requests, cached configs
- **Background Processes**: Non-blocking operations
- **Small Bundle**: ~2MB installed size

## 🧪 Testing Strategy

### Manual Testing
- Command execution
- Error scenarios
- User workflows

### Future: Automated Testing
- Unit tests for utilities
- Integration tests for commands
- E2E tests for workflows

## 📚 Documentation

### For Users
- **README.md** - Getting started guide
- **QUICK_REFERENCE.md** - Command reference
- **EXAMPLES.md** - Real-world workflows

### For Developers
- **BUILD.md** - Build instructions
- **CONTRIBUTING.md** - How to contribute
- **Code comments** - Inline documentation

### For Maintainers
- **CHANGELOG.md** - Version history
- **FEATURES.md** - Feature tracking

## 🚀 Deployment

### NPM Registry
```bash
npm publish --access public
```

### GitHub Releases
- Tag versions
- Publish release notes
- Attach binaries

### Docker Image (Future)
```bash
docker pull kolaybase/cli:latest
```

## 🛣️ Roadmap

### v0.1.0 (Current)
- ✅ Core commands
- ✅ Authentication
- ✅ Project management
- ✅ Database tools
- ✅ Code generation

### v0.2.0
- [ ] Edge Functions
- [ ] Storage management
- [ ] Webhooks
- [ ] Shell completion

### v0.3.0
- [ ] CI/CD helpers
- [ ] Performance tools
- [ ] Schema visualization
- [ ] Templates

### v1.0.0
- [ ] Plugin system
- [ ] GraphQL support
- [ ] Advanced monitoring
- [ ] Testing tools

## 🤝 Contributing

We welcome contributions! See [CONTRIBUTING.md](./CONTRIBUTING.md) for:
- Development setup
- Code style guide
- Pull request process
- Testing requirements

## 📞 Support

- **Issues**: [GitHub Issues](https://github.com/yourusername/v0-kolaybase/issues)
- **Discussions**: [GitHub Discussions](https://github.com/yourusername/v0-kolaybase/discussions)
- **Documentation**: [Full Docs](https://kolaybase.dev/docs)
- **Email**: support@kolaybase.dev

## 📄 License

MIT License - see [LICENSE](./LICENSE) file

## 🙏 Acknowledgments

- Inspired by [Supabase CLI](https://github.com/supabase/cli)
- Built with love for the developer community
- Thanks to all contributors

---

**Ready to get started?**

```bash
npm install -g @kolaybase/cli
kb login
kb init
kb start
```

Happy coding! 🚀
