# Design Decisions

This document records key design and technical decisions made during the development of Anti-Gravity theme.

## Design System

### Font Choice: Inter + JetBrains Mono

**Decision:** Use Inter for sans-serif and JetBrains Mono for monospace.

**Rationale:**

- Inter is highly readable at all sizes
- Excellent support for UI design with features like tabular numbers
- JetBrains Mono is optimized for code readability
- Both fonts are open source and freely available via @fontsource

**Alternatives Considered:**

- Geist Sans/Mono - Newer, but less established
- Plus Jakarta Sans - Good alternative, slightly more personality

### Primary Color: Indigo (#4F46E5)

**Decision:** Use indigo as the primary color with slight adjustments for dark mode.

**Rationale:**

- Matches Linear.app's aesthetic
- Professional and modern feel
- Good contrast ratios in both light and dark modes
- Versatile - works for various industries

**Color Values:**

- Light mode: `#4F46E5` (hover: `#4338CA`)
- Dark mode: `#6366F1` (hover: `#818CF8`)

### Border Radius: 6/10/14px Scale

**Decision:** Use a three-tier radius system.

**Rationale:**

- 6px (sm): Small elements like badges, tags
- 10px (default): Buttons, inputs, cards
- 14px (lg): Large cards, modals, hero sections
- Consistent with Linear's subtle rounded corners

### Spacing: 4px Base Unit

**Decision:** Use 4px as the base spacing unit with a scale of 4/8/12/16/24/32/48/64.

**Rationale:**

- 4px provides fine-grained control
- Scale covers common use cases
- Aligns with Tailwind's default spacing
- Creates visual rhythm and consistency

## Technical Decisions

### Astro + React Islands

**Decision:** Use Astro as the framework with React only for interactive components.

**Rationale:**

- Astro provides excellent performance with zero JS by default
- React islands allow for complex interactivity where needed
- Radix UI requires React for accessible primitives
- Best of both worlds: static performance + dynamic interactivity

### Radix UI for Primitives

**Decision:** Use Radix UI for accessible component primitives.

**Rationale:**

- Unstyled, allowing full design control
- Excellent accessibility out of the box
- Handles complex interactions (focus management, keyboard nav)
- Well-maintained and documented

**Components Used:**

- Dialog (modals)
- Dropdown Menu
- Tabs
- Accordion
- Tooltip
- Popover
- Switch
- Checkbox
- Radio Group
- Select
- Scroll Area
- Toast
- Slot

### Class Variance Authority (CVA)

**Decision:** Use CVA for component variant management.

**Rationale:**

- Type-safe variant definitions
- Clean API for multiple variants
- Works well with Tailwind CSS
- Reduces conditional class logic

### CSS Variables for Theming

**Decision:** Use CSS custom properties for all design tokens.

**Rationale:**

- Easy theme switching (light/dark)
- No JavaScript required for theme changes
- Can be overridden at any level
- Works with Tailwind's arbitrary value syntax

### Content Collections for Blog/Docs

**Decision:** Use Astro's content collections for blog and documentation.

**Rationale:**

- Type-safe frontmatter
- Built-in validation
- Automatic slug generation
- MDX support for rich content

## Component Decisions

### Button: 6 Variants

**Decision:** Provide primary, secondary, ghost, destructive, link, and outline variants.

**Rationale:**

- Primary: Main CTAs
- Secondary: Secondary actions
- Ghost: Subtle actions, toolbars
- Destructive: Dangerous actions
- Link: Inline text links
- Outline: Alternative to secondary

### Card: Composable Structure

**Decision:** Use composable Card with CardHeader, CardTitle, CardDescription, CardContent, CardFooter.

**Rationale:**

- Flexible composition
- Consistent structure
- Easy to customize
- Follows shadcn/ui patterns

### Hero: 3 Variants

**Decision:** Provide default, gradient, and split layout variants.

**Rationale:**

- Default: Clean, centered layout
- Gradient: Visual interest with subtle gradient
- Split: Image/content side-by-side
- Covers most landing page needs

### Theme Toggle: 3 States

**Decision:** Support light, dark, and system theme options.

**Rationale:**

- Respects user preference
- System option follows OS setting
- Persists choice in localStorage
- Smooth transitions between themes

## File Structure

### Component Organization

**Decision:** Organize components into ui/, layout/, and sections/ directories.

**Rationale:**

- ui/: Reusable primitives (Button, Card, Input)
- layout/: Page structure (Navbar, Footer)
- sections/: Page sections (Hero, Features, Pricing)
- Clear separation of concerns

### Config in src/config/

**Decision:** Centralize configuration in src/config/site.ts.

**Rationale:**

- Single source of truth
- Easy to update site-wide settings
- Type-safe configuration
- Separates content from code

## Performance Decisions

### Minimal JavaScript

**Decision:** Ship zero JavaScript by default, hydrate only interactive components.

**Rationale:**

- Faster page loads
- Better Core Web Vitals
- Reduced bandwidth
- Better for SEO

### Font Loading Strategy

**Decision:** Use @fontsource with font-display: swap.

**Rationale:**

- Self-hosted fonts (no external requests)
- Prevents invisible text during load
- Subset fonts for smaller file sizes
- Preload critical fonts

### Image Optimization

**Decision:** Use Astro's built-in image optimization.

**Rationale:**

- Automatic format conversion (WebP, AVIF)
- Responsive images with srcset
- Lazy loading by default
- Prevents layout shift with dimensions

## Accessibility Decisions

### Focus Ring Style

**Decision:** Use a 2px ring with primary color and offset.

**Rationale:**

- Visible on all backgrounds
- Consistent across components
- Meets WCAG requirements
- Doesn't obscure content

### Reduced Motion Support

**Decision:** Disable animations when prefers-reduced-motion is set.

**Rationale:**

- Respects user preferences
- Important for vestibular disorders
- Easy to implement globally
- No functionality loss

### Color Contrast

**Decision:** Maintain WCAG AA contrast ratios (4.5:1 for text).

**Rationale:**

- Ensures readability
- Legal compliance in some regions
- Better for all users
- Tested in both themes

## Animation Decisions

### Antigravity Animation Integration

**Decision:** Integrate ReactBits Antigravity animation as a signature visual element.

**Rationale:**

- Creates a unique, memorable visual identity for the theme
- Aligns with the "Anti-Gravity" theme name
- Provides an interactive, engaging user experience
- Demonstrates advanced WebGL/Three.js capabilities

**Implementation:**

- Uses Three.js and @react-three/fiber for WebGL rendering
- Implemented as a React island for Astro compatibility
- Graceful fallback to gradient when WebGL is not supported
- Configurable props for customization (count, color, shape, etc.)

**Components Created:**

- `Antigravity.tsx`: Core React component with Three.js canvas
- `AntigravityIsland.astro`: Astro wrapper with custom element hydration
- Hero variant "antigravity": Full-page hero with particle background

**Props Available:**

- `count`: Number of particles (default: 300)
- `color`: Particle color in hex (default: #6366f1)
- `particleShape`: capsule | sphere | box | tetrahedron
- `autoAnimate`: Auto-animate when mouse is idle
- `magnetRadius`: Magnetic attraction radius
- `ringRadius`: Ring formation radius
- `waveSpeed`: Wave animation speed
- `waveAmplitude`: Wave motion amplitude
- `lerpSpeed`: Interpolation speed for smooth movement

**Performance Considerations:**

- Lazy-loaded via custom element to avoid blocking initial render
- WebGL context check before initialization
- Fallback gradient for unsupported browsers
- Particle count can be reduced for lower-end devices

**Alternatives Considered:**

- CSS-only particle effects - Less impressive, limited interactivity
- Canvas 2D particles - Simpler but less performant for many particles
- Pre-rendered video background - No interactivity, larger file size

### SparklesLogoCloud Integration

**Decision:** Add SparklesLogoCloud component from MVPBlocks for social proof section.

**Rationale:**

- Adds visual interest to the logo cloud section
- Creates a premium, polished feel
- Particle effects draw attention to trusted companies
- Complements the Antigravity animation theme

**Implementation:**

- Uses @tsparticles/react for particle rendering
- Framer Motion for fade-in animation
- Integrated into Testimonials.astro social proof section
- Configurable particle properties

**Components Created:**

- `SparklesCore.tsx`: Core particle animation component using tsparticles
- `SparklesLogoCloud.tsx`: Logo cloud with sparkle background
- `SparklesLogoCloudIsland.astro`: Astro wrapper for React island

**Props Available:**

- `title`: First line of heading (default: "Trusted by experts.")
- `subtitle`: Second line of heading (default: "Used by the leaders.")
- `particleColor`: Particle color in hex (default: #6366f1)
- `particleDensity`: Number of particles (default: 80)
- `minSize`: Minimum particle size (default: 0.6)
- `maxSize`: Maximum particle size (default: 1.4)
- `speed`: Animation speed (default: 2)

**Dependencies Added:**

- @tsparticles/react
- @tsparticles/engine
- @tsparticles/slim
- framer-motion

**Performance Considerations:**

- Uses client:visible for lazy loading
- Particle density is configurable for performance tuning
- Graceful degradation if particles fail to load
- Lightweight compared to WebGL-based alternatives

**Alternatives Considered:**

- CSS-only sparkle effects - Less dynamic, limited customization
- Three.js particles - Heavier, overkill for this use case
- Static logo grid - Less engaging, no visual interest

---

_Last updated: January 2024_
