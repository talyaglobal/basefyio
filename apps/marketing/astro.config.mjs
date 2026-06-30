// @ts-check
import { defineConfig } from 'astro/config';
import sitemap from '@astrojs/sitemap';

// Canonical production domain (confirmed): https://basefyio.com
// Drives canonical URLs, OpenGraph/Twitter image URLs, robots.txt, and the
// generated sitemap. SITE_URL may override it for staging/preview builds only.
const SITE = process.env.SITE_URL ?? 'https://basefyio.com';

export default defineConfig({
  site: SITE,
  integrations: [sitemap()],
  trailingSlash: 'never',
  build: {
    format: 'directory',
  },
});
