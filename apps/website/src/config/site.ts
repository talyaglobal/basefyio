/**
 * Kolaybase marketing site configuration
 * Canonical domain: https://kolaybase.com
 */

const getSiteUrl = (): string => {
  if (typeof import.meta !== 'undefined' && import.meta.env?.PUBLIC_SITE_URL) {
    return import.meta.env.PUBLIC_SITE_URL;
  }
  return 'https://kolaybase.com';
};

const getAdminUrl = (): string => {
  if (typeof import.meta !== 'undefined' && import.meta.env?.PUBLIC_ADMIN_URL) {
    return import.meta.env.PUBLIC_ADMIN_URL;
  }
  return 'https://app.kolaybase.com';
};

export const siteConfig = {
  name: 'Kolaybase',
  description:
    'Run projects, teams, billing, and integrations from one place. Secure infrastructure, APIs, and enterprise-ready workflows.',
  url: getSiteUrl(),
  ogImage: '/og-image.png',
  logoPath: '/logo.svg',
  author: 'Kolaybase',
  email: 'hello@kolaybase.com',
  adminPanelUrl: getAdminUrl(),

  navLinks: [
    { label: 'Features', href: '/features' },
    { label: 'Pricing', href: '/pricing' },
    { label: 'Blog', href: '/blog' },
    { label: 'Docs', href: '/docs' },
    { label: 'About', href: '/about' },
  ],

  footerLinks: {
    product: [
      { label: 'Features', href: '/features' },
      { label: 'Pricing', href: '/pricing' },
      { label: 'Roadmap', href: '/roadmap' },
      { label: 'Changelog', href: '/changelog' },
    ],
    company: [
      { label: 'About', href: '/about' },
      { label: 'Blog', href: '/blog' },
      { label: 'Contact', href: '/contact' },
    ],
    resources: [
      { label: 'Documentation', href: '/docs' },
      { label: 'Installation', href: '/docs/installation' },
      { label: 'API & integrations', href: '/contact' },
    ],
    legal: [
      { label: 'Privacy', href: '/legal/privacy' },
      { label: 'Terms', href: '/legal/terms' },
    ],
  },

  socials: {
    twitter: 'https://twitter.com/kolaybase',
    github: 'https://github.com/kolaybase',
    discord: 'https://discord.gg/kolaybase',
    linkedin: 'https://www.linkedin.com/company/kolaybase',
  },
};

export const features = [
  {
    id: 'speed',
    title: 'Performance at scale',
    description:
      'A fast static marketing layer and a modern React admin keep latency low. Plans and quotas scale with your teams; CDN-backed assets stay separate from your API.',
    icon: 'Zap',
  },
  {
    id: 'teams',
    title: 'Teams, roles, access',
    description:
      'Organize work around teams with invitations and permission boundaries that fit enterprise expectations. Everyone sees the same operational truth.',
    icon: 'Users',
  },
  {
    id: 'api',
    title: 'APIs & integrations',
    description:
      'Use REST APIs for automation and reporting. Monthly request budgets follow your plan; extend with webhooks and common SaaS integration patterns.',
    icon: 'Code',
  },
  {
    id: 'security',
    title: 'Security & compliance',
    description:
      'Authentication and billing align with providers you can audit, such as Stripe. Usage trails help operations and reviews; enterprise buyers can add SSO, residency, and SLAs with sales.',
    icon: 'Shield',
  },
  {
    id: 'ux',
    title: 'Cohesive product UI',
    description:
      'Marketing and app share one palette and typography system. Light and dark themes, focus rings, and readable type reduce fatigue on desktop and mobile.',
    icon: 'Palette',
  },
  {
    id: 'insights',
    title: 'Visibility into usage',
    description:
      'Track projects, storage, members, and API use against your plan. Make upgrade or downgrade decisions with data. Exports and deeper reporting evolve on the roadmap.',
    icon: 'BarChart',
  },
  {
    id: 'seo',
    title: 'Discoverable marketing',
    description:
      'Structured data, canonical URLs, and sitemaps help search engines. Static pages load quickly; Open Graph tags keep previews consistent.',
    icon: 'Search',
  },
  {
    id: 'support',
    title: 'Support & success',
    description:
      'Documentation and contact options are open to everyone. Paid tiers target faster responses; enterprise agreements can add SLAs and named contacts.',
    icon: 'Headphones',
  },
];

export const testimonials = [
  {
    id: 1,
    content:
      'We consolidated projects and teams into one pane. Our onboarding time dropped noticeably.',
    author: 'Sarah C.',
    role: 'Head of Operations',
    company: 'Technology company',
    avatar: '/avatars/avatar-1.jpg',
  },
  {
    id: 2,
    content:
      'API and role plumbing let us integrate with CRM and support tools without bespoke glue.',
    author: 'Marcus J.',
    role: 'CTO',
    company: 'B2B SaaS',
    avatar: '/avatars/avatar-2.jpg',
  },
  {
    id: 3,
    content:
      'Security and audit expectations were met earlier in procurement because the model is clear.',
    author: 'Elena R.',
    role: 'IT Lead',
    company: 'Financial services',
    avatar: '/avatars/avatar-3.jpg',
  },
];

export const faqItems = [
  {
    question: 'What is Kolaybase?',
    answer:
      'Kolaybase brings projects, teams, billing, and APIs together. Plans encode project caps, storage, seats, API limits, and optional dedicated resources. Billing runs on monthly cycles through Stripe.',
  },
  {
    question: 'Where is data hosted?',
    answer:
      'Default deployments are cloud-based. Enterprise buyers can discuss residency, private networking, and access controls before contract. Backup policies and audit trails are reviewed jointly with your security stakeholders.',
  },
  {
    question: 'Can we start with a pilot?',
    answer:
      'Yes. We can scope a time-bound pilot or limited rollout. You pick a plan at signup; paid and free transitions follow billing or sales workflows. Large rollouts may add SSO and provisioning projects.',
  },
  {
    question: 'How do integrations and API limits work?',
    answer:
      'Automate with REST APIs; monthly request allowances depend on your plan. When you approach limits, upgrade paths or quota increases are evaluated. Webhooks cover event-style integrations for common SaaS patterns.',
  },
  {
    question: 'How do I get support?',
    answer:
      'Documentation and the contact form are available to everyone. Paid tiers aim for faster responses; enterprise contracts may define SLAs, dedicated channels, and operational reviews.',
  },
];

export const changelogEntries = [
  {
    version: '2026.4',
    date: '2026-04-15',
    title: 'Marketing site refresh',
    description: 'Astro marketing site, JSON-LD, sitemap, and English-first content.',
    changes: ['Performance and accessibility tweaks', 'Sitemap and robots.txt', 'Branding alignment with the app UI'],
    type: 'release' as const,
  },
];

export const roadmapItems = [
  {
    id: 1,
    title: 'Advanced reporting',
    description: 'Dashboards and exports tailored to operators.',
    status: 'in-progress' as const,
    quarter: '2026 Q2',
  },
  {
    id: 2,
    title: 'More SSO providers',
    description: 'Broader enterprise identity coverage.',
    status: 'planned' as const,
    quarter: '2026 Q2',
  },
  {
    id: 3,
    title: 'Mobile experience',
    description: 'PWA polish and notification improvements.',
    status: 'planned' as const,
    quarter: '2026 Q3',
  },
];

export type SiteConfig = typeof siteConfig;
export type Feature = (typeof features)[number];
export type Testimonial = (typeof testimonials)[number];
export type FAQItem = (typeof faqItems)[number];
export type ChangelogEntry = (typeof changelogEntries)[number];
export type RoadmapItem = (typeof roadmapItems)[number];
