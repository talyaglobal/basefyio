# Contributing to Anti-Gravity

Thank you for your interest in contributing to Anti-Gravity! This document provides guidelines and instructions for contributing.

## Table of Contents

- [Code of Conduct](#code-of-conduct)
- [Getting Started](#getting-started)
- [Development Workflow](#development-workflow)
- [Pull Request Process](#pull-request-process)
- [Coding Standards](#coding-standards)
- [Commit Messages](#commit-messages)
- [Reporting Issues](#reporting-issues)

## Code of Conduct

By participating in this project, you agree to maintain a respectful and inclusive environment for everyone.

## Getting Started

### Prerequisites

- Node.js 18.x or higher
- npm 9.x or higher
- Git

### Setup

1. Fork the repository
2. Clone your fork:
   ```bash
   git clone https://github.com/YOUR_USERNAME/anti-gravity.git
   cd anti-gravity
   ```
3. Install dependencies:
   ```bash
   npm install
   ```
4. Create a branch for your changes:
   ```bash
   git checkout -b feature/your-feature-name
   ```

## Development Workflow

### Running the Development Server

```bash
npm run dev
```

The site will be available at `http://localhost:4321`.

### Available Scripts

| Command | Description |
|---------|-------------|
| `npm run dev` | Start development server |
| `npm run build` | Build for production |
| `npm run preview` | Preview production build |
| `npm run typecheck` | Run TypeScript type checking |
| `npm run lint` | Run ESLint |
| `npm run lint:fix` | Fix ESLint errors |
| `npm run format` | Format code with Prettier |
| `npm run format:check` | Check code formatting |

### Project Structure

```
anti-gravity/
├── public/              # Static assets
├── src/
│   ├── components/      # UI components
│   │   ├── animations/  # Animation components
│   │   ├── layout/      # Layout components
│   │   ├── sections/    # Page sections
│   │   └── ui/          # Base UI components
│   ├── config/          # Site configuration
│   ├── content/         # MDX content (blog, docs)
│   ├── layouts/         # Page layouts
│   ├── lib/             # Utility functions
│   ├── pages/           # Page routes
│   └── styles/          # Global styles
├── .eslintrc.cjs        # ESLint configuration
├── .prettierrc          # Prettier configuration
├── astro.config.mjs     # Astro configuration
├── tailwind.config.mjs  # Tailwind configuration
└── tsconfig.json        # TypeScript configuration
```

## Pull Request Process

1. **Ensure your code passes all checks:**
   ```bash
   npm run typecheck
   npm run lint
   npm run format:check
   npm run build
   ```

2. **Update documentation** if you're adding new features or changing existing behavior.

3. **Write meaningful commit messages** following our commit message guidelines.

4. **Create a Pull Request** with:
   - A clear title describing the change
   - A description of what was changed and why
   - Screenshots for UI changes
   - Reference to any related issues

5. **Wait for review** - maintainers will review your PR and may request changes.

## Coding Standards

### TypeScript

- Use TypeScript for all new code
- Define proper types for props and function parameters
- Avoid using `any` type
- Use type imports: `import type { ... } from '...'`

### Components

- Use Astro components (`.astro`) for static content
- Use React components (`.tsx`) only for interactive elements
- Follow the existing component structure
- Include proper accessibility attributes

### Styling

- Use Tailwind CSS utility classes
- Use CSS variables for theming (defined in `globals.css`)
- Follow the design token system
- Ensure dark mode compatibility

### Accessibility

- Include proper ARIA labels
- Ensure keyboard navigation works
- Test with screen readers
- Support reduced motion preferences

## Commit Messages

We follow the [Conventional Commits](https://www.conventionalcommits.org/) specification:

```
<type>(<scope>): <description>

[optional body]

[optional footer]
```

### Types

- `feat`: New feature
- `fix`: Bug fix
- `docs`: Documentation changes
- `style`: Code style changes (formatting, etc.)
- `refactor`: Code refactoring
- `perf`: Performance improvements
- `test`: Adding or updating tests
- `chore`: Maintenance tasks

### Examples

```
feat(components): add new Timeline component
fix(navbar): resolve mobile menu z-index issue
docs(readme): update installation instructions
style(button): improve hover state animation
```

## Reporting Issues

### Bug Reports

When reporting bugs, please include:

1. **Description**: Clear description of the bug
2. **Steps to Reproduce**: How to reproduce the issue
3. **Expected Behavior**: What should happen
4. **Actual Behavior**: What actually happens
5. **Environment**: Browser, OS, Node version
6. **Screenshots**: If applicable

### Feature Requests

When requesting features, please include:

1. **Description**: Clear description of the feature
2. **Use Case**: Why this feature would be useful
3. **Proposed Solution**: How you think it should work
4. **Alternatives**: Any alternatives you've considered

## Questions?

If you have questions, feel free to:

- Open a GitHub Discussion
- Join our Discord community
- Check existing issues and discussions

Thank you for contributing to Anti-Gravity! 🚀
