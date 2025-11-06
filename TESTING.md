# Testing Guide

This project uses Jest for testing with React Testing Library for component testing.

## Setup

The testing system is already configured. The following dependencies are installed:

- `jest` - Testing framework
- `@testing-library/react` - React component testing utilities
- `@testing-library/jest-dom` - Custom Jest matchers for DOM elements
- `@testing-library/user-event` - User interaction simulation
- `jest-environment-jsdom` - DOM environment for Jest
- `@types/jest` - TypeScript types for Jest

## Running Tests

### Run all tests
```bash
npm test
```

### Run tests in watch mode (for development)
```bash
npm run test:watch
```

### Run tests with coverage report
```bash
npm run test:coverage
```

### Run tests in CI mode
```bash
npm run test:ci
```

## Test Structure

Tests should be placed in one of these locations:
- `__tests__/` directories next to the code being tested
- Files with `.test.ts` or `.test.tsx` extensions
- Files with `.spec.ts` or `.spec.tsx` extensions

## Writing Tests

### Utility Function Tests

Example: `lib/__tests__/utils.test.ts`

```typescript
import { cn } from '../utils'

describe('cn utility function', () => {
  it('should merge class names correctly', () => {
    const result = cn('foo', 'bar')
    expect(result).toBe('foo bar')
  })
})
```

### React Component Tests

Example: `components/ui/__tests__/button.test.tsx`

```typescript
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { Button } from '../button'

describe('Button Component', () => {
  it('renders a button with text', () => {
    render(<Button>Click me</Button>)
    const button = screen.getByRole('button', { name: /click me/i })
    expect(button).toBeInTheDocument()
  })
})
```

## Test Configuration

- **Jest Config**: `jest.config.js` - Main Jest configuration
- **Jest Setup**: `jest.setup.js` - Global test setup and mocks

## Mocking

### Next.js Router

The Next.js router is automatically mocked in `jest.setup.js`. You can access it in tests:

```typescript
import { useRouter } from 'next/navigation'

// In your component tests, useRouter() will return mocked values
```

### Next.js Image

The Next.js `Image` component is automatically mocked to render as a regular `img` tag.

## Best Practices

1. **Test user behavior, not implementation details**
   - Use `getByRole`, `getByLabelText`, etc. instead of `getByTestId`
   - Test what users see and interact with

2. **Keep tests focused**
   - One test should verify one behavior
   - Use descriptive test names

3. **Use async utilities properly**
   - Use `await` with user interactions
   - Use `waitFor` for async updates

4. **Clean up after tests**
   - React Testing Library automatically cleans up after each test
   - No manual cleanup needed for most cases

## Coverage

Coverage reports are generated in the `coverage/` directory when running `npm run test:coverage`.

Coverage is collected from:
- `app/**/*.{js,jsx,ts,tsx}`
- `components/**/*.{js,jsx,ts,tsx}`
- `lib/**/*.{js,jsx,ts,tsx}`
- `hooks/**/*.{js,jsx,ts,tsx}`

## Troubleshooting

### Tests not finding modules
- Check that `tsconfig.json` paths match Jest `moduleNameMapper`
- Ensure imports use the `@/` alias correctly

### React component not rendering
- Make sure you're using `render()` from `@testing-library/react`
- Check that the component is properly exported

### Async issues
- Use `await` with user interactions
- Use `waitFor` for async state updates

