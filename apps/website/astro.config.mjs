import mdx from '@astrojs/mdx';
import react from '@astrojs/react';
import sitemap from '@astrojs/sitemap';
import { defineConfig } from 'astro/config';

// Production canonical URL for sitemap, RSS, and meta fallbacks
const siteUrl =
  process.env.PUBLIC_SITE_URL || import.meta.env.PUBLIC_SITE_URL || 'https://kolaybase.com';

export default defineConfig({
  site: siteUrl,
  integrations: [react(), mdx(), sitemap()],
  markdown: {
    shikiConfig: {
      theme: 'github-dark',
      wrap: true,
    },
  },
  vite: {
    ssr: {
      noExternal: ['@radix-ui/*'],
    },
  },
});
