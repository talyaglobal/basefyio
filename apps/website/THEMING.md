
# Theming Guide

This guide explains how to customize the Anti-Gravity theme to match your brand.

## Table of Contents

- [Color System](#color-system)
- [Typography](#typography)
- [Spacing](#spacing)
- [Border Radius](#border-radius)
- [Shadows](#shadows)
- [Motion](#motion)
- [Components](#components)
- [Dark Mode](#dark-mode)

## Color System

### Color Tokens

All colors are defined as CSS variables in `src/styles/globals.css`. This makes it easy to change the entire color scheme by modifying a few values.

#### Background Colors

```css
:root {
  --color-bg: #ffffff;        /* Main background */
  --color-surface: #fafafa;   /* Elevated surfaces */
  --color-surface-2: #f5f5f5; /* Secondary surfaces */
}

.dark {
  --color-bg: #0a0a0a;
  --color-surface: #141414;
  --color-surface-2: #1f1f1f;
}
```

#### Text Colors

```css
:root {
  --color-text: #0a0a0a;           /* Primary text */
  --color-text-secondary: #404040; /* Secondary text */
  --color-muted: #737373;          /* Muted/disabled text */
}

.dark {
  --color-text: #fafafa;
  --color-text-secondary: #a3a3a3;
  --color-muted: #737373;
}
```

#### Border Colors

```css
:root {
  --color-border: rgba(0, 0, 0, 0.08);       /* Default border */
  --color-border-hover: rgba(0, 0, 0, 0.15); /* Hover state */
}

.dark {
  --color-border: rgba(255, 255, 255, 0.08);
  --color-border-hover: rgba(255, 255, 255, 0.15);
}
```

#### Primary Color

The primary color is used for buttons, links, and accents:

```css
:root {
  --color-primary: #4f46e5;                    /* Main primary */
  --color-primary-hover: #4338ca;              /* Hover state */
  --color-primary-foreground: #ffffff;         /* Text on primary */
  --color-primary-muted: rgba(79, 70, 229, 0.15); /* Subtle backgrounds */
}

.dark {
  --color-primary: #6366f1;
  --color-primary-hover: #818cf8;
  --color-primary-foreground: #ffffff;
  --color-primary-muted: rgba(99, 102, 241, 0.2);
}
```

#### Semantic Colors

```css
:root {
  --color-danger: #dc2626;
  --color-danger-foreground: #ffffff;
  --color-success: #16a34a;
  --color-success-foreground: #ffffff;
  --color-warning: #ca8a04;
  --color-warning-foreground: #ffffff;
}
```

### Changing the Primary Color

To change the primary color to green:

```css
:root {
  --color-primary: #10b981;
  --color-primary-hover: #059669;
  --color-primary-foreground: #ffffff;
  --color-primary-muted: rgba(16, 185, 129, 0.15);
}

.dark {
  --color-primary: #34d399;
  --color-primary-hover: #6ee7b7;
  --color-primary-foreground: #0a0a0a;
  --color-primary-muted: rgba(52, 211, 153, 0.2);
}
```

### Color Palette Examples

#### Blue (Default)
```css
--color-primary: #4f46e5;
--color-primary-hover: #4338ca;
```

#### Green
```css
--color-primary: #10b981;
--color-primary-hover: #059669;
```

#### Purple
```css
--color-primary: #8b5cf6;
--color-primary-hover: #7c3aed;
```

#### Orange
```css
--color-primary: #f97316;
--color-primary-hover: #ea580c;
```

#### Pink
```css
--color-primary: #ec4899;
--color-primary-hover: #db2777;
```

## Typography

### Font Families

Fonts are configured in `tailwind.config.mjs`:

```javascript
fontFamily: {
  sans: ['Inter', 'system-ui', '-apple-system', 'sans-serif'],
  mono: ['JetBrains Mono', 'Menlo', 'Monaco', 'monospace'],
}
```

### Changing Fonts

1. **Install the font package:**

```bash
npm install @fontsource/plus-jakarta-sans
```

2. **Import in globals.css:**

```css
@import '@fontsource/plus-jakarta-sans/400.css';
@import '@fontsource/plus-jakarta-sans/500.css';
@import '@fontsource/plus-jakarta-sans/600.css';
@import '@fontsource/plus-jakarta-sans/700.css';
```

3. **Update Tailwind config:**

```javascript
fontFamily: {
  sans: ['Plus Jakarta Sans', 'system-ui', 'sans-serif'],
}
```

### Typography Scale

| Class | Size | Line Height | Weight |
|-------|------|-------------|--------|
| `text-display` | 4rem (64px) | 1.1 | 700 |
| `text-h1` | 3rem (48px) | 1.15 | 700 |
| `text-h2` | 2.25rem (36px) | 1.2 | 600 |
| `text-h3` | 1.5rem (24px) | 1.3 | 600 |
| `text-h4` | 1.25rem (20px) | 1.4 | 600 |
| `text-h5` | 1.125rem (18px) | 1.4 | 600 |
| `text-h6` | 1rem (16px) | 1.5 | 600 |
| `text-body` | 1rem (16px) | 1.6 | 400 |
| `text-body-sm` | 0.875rem (14px) | 1.5 | 400 |
| `text-small` | 0.75rem (12px) | 1.4 | 400 |
| `text-tiny` | 0.6875rem (11px) | 1.4 | 400 |

## Spacing

Anti-Gravity uses a 4px base unit for spacing:

| Token | Value | Pixels |
|-------|-------|--------|
| `space-1` | 0.25rem | 4px |
| `space-2` | 0.5rem | 8px |
| `space-3` | 0.75rem | 12px |
| `space-4` | 1rem | 16px |
| `space-6` | 1.5rem | 24px |
| `space-8` | 2rem | 32px |
| `space-12` | 3rem | 48px |
| `space-16` | 4rem | 64px |

Use Tailwind classes: `p-4`, `m-8`, `gap-6`, etc.

## Border Radius

Three radius sizes are available:

| Token | Value | Use Case |
|-------|-------|----------|
| `rounded-sm` | 6px | Small elements, badges |
| `rounded` / `rounded-md` | 10px | Buttons, inputs, cards |
| `rounded-lg` | 14px | Large cards, modals |

## Shadows

Subtle shadows for depth:

```css
/* Light shadow for subtle elevation */
shadow-subtle: 0 1px 2px 0 rgb(0 0 0 / 0.03)

/* Soft shadow for hover states */
shadow-soft: 0 2px 8px -2px rgb(0 0 0 / 0.08)

/* Medium shadow for modals/dropdowns */
shadow-medium: 0 4px 12px -2px rgb(0 0 0 / 0.1)

/* Focus ring */
shadow-focus: 0 0 0 3px var(--color-primary-muted)
```

## Motion

### Duration

| Token | Value | Use Case |
|-------|-------|----------|
| `duration-150` | 150ms | Fast interactions (hover) |
| `duration-200` | 200ms | Standard transitions |
| `duration-250` | 250ms | Slower, deliberate animations |

### Easing

```css
/* Standard easing */
transition-timing-function: cubic-bezier(0.4, 0, 0.2, 1);
```

### Reduced Motion

The theme respects `prefers-reduced-motion`:

```css
@media (prefers-reduced-motion: reduce) {
  * {
    animation-duration: 0.01ms !important;
    transition-duration: 0.01ms !important;
  }
}
```

## Components

### Button Customization

Modify button styles in `src/components/ui/Button.tsx`:

```tsx
const buttonVariants = cva(
  // Base styles
  ['inline-flex items-center justify-center', ...],
  {
    variants: {
      variant: {
        primary: ['bg-primary text-primary-foreground', ...],
        // Add custom variants here
        custom: ['bg-gradient-to-r from-purple-500 to-pink-500', ...],
      },
    },
  }
);
```

### Card Customization

Modify card styles in `src/components/ui/Card.tsx`:

```tsx
const cardVariants = cva(
  ['rounded-lg border border-border bg-bg', ...],
  {
    variants: {
      variant: {
        default: '',
        // Add custom variants
        gradient: 'bg-gradient-to-br from-surface to-bg',
      },
    },
  }
);
```

## Dark Mode

### How It Works

1. Theme preference is stored in `localStorage`
2. The `dark` class is added to `<html>` element
3. CSS variables change based on the class

### Theme Toggle

The theme toggle cycles through: light → dark → system

```typescript
// Get current theme
const theme = localStorage.getItem('theme'); // 'light' | 'dark' | 'system'

// Set theme
localStorage.setItem('theme', 'dark');
document.documentElement.classList.add('dark');
```

### Testing Dark Mode

1. Use the theme toggle in the navbar
2. Or use browser DevTools to emulate `prefers-color-scheme: dark`

### Dark Mode Best Practices

1. **Don't just invert colors** - Dark backgrounds should be slightly lighter than pure black
2. **Reduce contrast slightly** - Pure white on black can be harsh
3. **Adjust primary colors** - Slightly brighter primaries work better on dark backgrounds
4. **Test both modes** - Always verify your changes in both themes

## Best Practices

1. **Use tokens, not hardcoded values** - Always use CSS variables or Tailwind classes
2. **Maintain contrast ratios** - Ensure WCAG AA compliance (4.5:1 for text)
3. **Test responsively** - Check all breakpoints
4. **Test both themes** - Verify light and dark mode
5. **Use semantic colors** - `text-muted` instead of specific gray values
6. **Follow the spacing scale** - Stick to the defined spacing values

## Examples

### Custom Theme: Ocean

```css
:root {
  --color-bg: #f0f9ff;
  --color-surface: #e0f2fe;
  --color-surface-2: #bae6fd;
  --color-text: #0c4a6e;
  --color-text-secondary: #0369a1;
  --color-muted: #0284c7;
  --color-border: rgba(14, 165, 233, 0.2);
  --color-primary: #0ea5e9;
  --color-primary-hover: #0284c7;
}

.dark {
  --color-bg: #0c4a6e;
  --color-surface: #075985;
  --color-surface-2: #0369a1;
  --color-text: #f0f9ff;
  --color-text-secondary: #bae6fd;
  --color-muted: #7dd3fc;
  --color-border: rgba(125, 211, 252, 0.15);
  --color-primary: #38bdf8;
  --color-primary-hover: #7dd3fc;
}
```

### Custom Theme: Forest

```css
:root {
  --color-bg: #f0fdf4;
  --color-surface: #dcfce7;
  --color-surface-2: #bbf7d0;
  --color-text: #14532d;
  --color-text-secondary: #166534;
  --color-muted: #15803d;
  --color-border: rgba(34, 197, 94, 0.2);
  --color-primary: #22c55e;
  --color-primary-hover: #16a34a;
}
