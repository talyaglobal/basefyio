# QA Checklist

Quality assurance checklist for Anti-Gravity theme. Use this to verify all features work correctly before deployment.

## ✅ Accessibility (A11y)

### Keyboard Navigation
- [ ] All interactive elements are focusable with Tab key
- [ ] Focus order follows logical reading order
- [ ] No keyboard traps (can always Tab away)
- [ ] Enter/Space activates buttons and links
- [ ] Escape closes modals and dropdowns
- [ ] Arrow keys navigate within menus

### Focus Indicators
- [ ] Focus ring is visible on all interactive elements
- [ ] Focus ring has sufficient contrast (3:1 minimum)
- [ ] Focus ring is consistent across components
- [ ] Custom focus styles don't remove outline

### Screen Readers
- [ ] All images have alt text
- [ ] Form inputs have associated labels
- [ ] Buttons have accessible names
- [ ] Links have descriptive text (not "click here")
- [ ] ARIA labels used where needed
- [ ] Heading hierarchy is logical (h1 → h2 → h3)
- [ ] Skip link available for main content

### Color & Contrast
- [ ] Text contrast ratio ≥ 4.5:1 (WCAG AA)
- [ ] Large text contrast ratio ≥ 3:1
- [ ] UI component contrast ratio ≥ 3:1
- [ ] Information not conveyed by color alone
- [ ] Links distinguishable from text

### Motion
- [ ] Animations respect `prefers-reduced-motion`
- [ ] No auto-playing animations that can't be paused
- [ ] No flashing content (3 flashes/second max)

## ✅ Responsive Design

### Breakpoints
- [ ] Mobile: 320px - 639px
- [ ] Tablet: 640px - 1023px
- [ ] Desktop: 1024px - 1279px
- [ ] Wide: 1280px+

### Mobile (320px)
- [ ] All content is readable
- [ ] No horizontal scrolling
- [ ] Touch targets ≥ 44x44px
- [ ] Navigation is accessible (hamburger menu)
- [ ] Forms are usable
- [ ] Images scale properly

### Tablet (768px)
- [ ] Layout adapts appropriately
- [ ] Grid columns adjust
- [ ] Navigation works correctly
- [ ] Modals fit screen

### Desktop (1024px+)
- [ ] Full navigation visible
- [ ] Multi-column layouts work
- [ ] Hover states function
- [ ] Large images display correctly

### Wide Screens (1440px+)
- [ ] Content doesn't stretch too wide
- [ ] Max-width containers work
- [ ] Layout remains balanced

## ✅ Theme / Dark Mode

### Light Mode
- [ ] All text is readable
- [ ] Backgrounds are correct
- [ ] Borders are visible
- [ ] Images look correct
- [ ] Form elements styled properly

### Dark Mode
- [ ] All text is readable
- [ ] Backgrounds are correct (not pure black)
- [ ] Borders are visible
- [ ] Images look correct
- [ ] Form elements styled properly
- [ ] No "flash" on page load

### System Theme
- [ ] Respects `prefers-color-scheme`
- [ ] Updates when system theme changes
- [ ] Toggle works correctly

### Theme Persistence
- [ ] Theme saved to localStorage
- [ ] Theme persists across page loads
- [ ] Theme persists across sessions

## ✅ Components

### Button
- [ ] All variants render correctly
- [ ] All sizes render correctly
- [ ] Hover state works
- [ ] Active state works
- [ ] Focus state works
- [ ] Disabled state works
- [ ] Loading state works
- [ ] Icons align properly

### Card
- [ ] All variants render correctly
- [ ] Padding options work
- [ ] Interactive variant has hover effect
- [ ] Content slots work

### Badge
- [ ] All variants render correctly
- [ ] All sizes render correctly
- [ ] Text is readable

### Input
- [ ] Default state renders correctly
- [ ] Focus state works
- [ ] Error state works
- [ ] Disabled state works
- [ ] Placeholder visible
- [ ] Icons align properly

### Textarea
- [ ] Renders correctly
- [ ] Resizable (if enabled)
- [ ] Focus state works

### Theme Toggle
- [ ] Cycles through themes correctly
- [ ] Icons update appropriately
- [ ] Persists selection

## ✅ Pages

### Home (/)
- [ ] Hero section displays correctly
- [ ] All sections load
- [ ] CTAs are clickable
- [ ] Responsive on all breakpoints

### Features (/features)
- [ ] Feature grid displays correctly
- [ ] Icons render
- [ ] Responsive layout works

### Pricing (/pricing)
- [ ] Pricing cards display correctly
- [ ] Toggle switches billing period
- [ ] Popular plan highlighted
- [ ] CTAs work

### About (/about)
- [ ] Team section displays
- [ ] Timeline renders
- [ ] Values section works

### Contact (/contact)
- [ ] Form renders correctly
- [ ] Validation works
- [ ] Submit button works
- [ ] Contact info displays

### Blog (/blog)
- [ ] Post list displays
- [ ] Featured posts highlighted
- [ ] Tags work
- [ ] Pagination works (if applicable)

### Blog Post (/blog/[slug])
- [ ] Content renders correctly
- [ ] MDX components work
- [ ] Code blocks styled
- [ ] Images display
- [ ] Share buttons work
- [ ] Related posts show

### Docs (/docs)
- [ ] Sidebar navigation works
- [ ] Content renders correctly
- [ ] Code blocks styled
- [ ] Prev/Next navigation works

### Changelog (/changelog)
- [ ] Timeline displays correctly
- [ ] Version badges work
- [ ] Dates format correctly

### Roadmap (/roadmap)
- [ ] Status indicators work
- [ ] Timeline displays correctly
- [ ] Quarters organize correctly

### Legal Pages
- [ ] Privacy policy renders
- [ ] Terms of service renders
- [ ] Content is readable

### 404 Page
- [ ] Displays on invalid routes
- [ ] Back to home link works
- [ ] Styling is consistent

## ✅ Performance

### Lighthouse Scores (Target)
- [ ] Performance: 90+
- [ ] Accessibility: 95+
- [ ] Best Practices: 95+
- [ ] SEO: 95+

### Core Web Vitals
- [ ] LCP (Largest Contentful Paint): < 2.5s
- [ ] FID (First Input Delay): < 100ms
- [ ] CLS (Cumulative Layout Shift): < 0.1

### Assets
- [ ] Images optimized
- [ ] Fonts preloaded
- [ ] CSS minified
- [ ] JS minimal (islands only)

### Loading
- [ ] No layout shift on load
- [ ] Fonts don't cause FOUT/FOIT
- [ ] Images have dimensions set

## ✅ SEO

### Meta Tags
- [ ] Title tag on all pages
- [ ] Meta description on all pages
- [ ] Canonical URLs set
- [ ] Robots meta tag appropriate

### Open Graph
- [ ] og:title set
- [ ] og:description set
- [ ] og:image set
- [ ] og:url set
- [ ] og:type set

### Twitter Cards
- [ ] twitter:card set
- [ ] twitter:title set
- [ ] twitter:description set
- [ ] twitter:image set

### Structured Data
- [ ] Organization schema (if applicable)
- [ ] Article schema for blog posts
- [ ] Breadcrumb schema

### Technical SEO
- [ ] Sitemap generated
- [ ] robots.txt configured
- [ ] No broken links
- [ ] Proper heading hierarchy

## ✅ Browser Compatibility

### Desktop Browsers
- [ ] Chrome (latest)
- [ ] Firefox (latest)
- [ ] Safari (latest)
- [ ] Edge (latest)

### Mobile Browsers
- [ ] Chrome Mobile
- [ ] Safari iOS
- [ ] Samsung Internet

## ✅ Build & Deploy

### Build
- [ ] `npm run build` succeeds
- [ ] No TypeScript errors
- [ ] No console errors
- [ ] No console warnings (or acceptable)

### Preview
- [ ] `npm run preview` works
- [ ] All pages accessible
- [ ] Assets load correctly

### Environment
- [ ] Environment variables documented
- [ ] Production URLs configured
- [ ] Analytics configured (if applicable)

## ✅ Content

### Copy
- [ ] No placeholder text (Lorem ipsum)
- [ ] No typos
- [ ] Consistent tone
- [ ] CTAs are clear

### Images
- [ ] All images load
- [ ] Alt text is descriptive
- [ ] Appropriate file sizes
- [ ] Correct aspect ratios

### Links
- [ ] Internal links work
- [ ] External links open in new tab
- [ ] No broken links
- [ ] Email links work

## 📝 Notes

Use this section to document any issues found or decisions made during QA.

---

**QA Completed By:** ________________

**Date:** ________________

**Version:** ________________
