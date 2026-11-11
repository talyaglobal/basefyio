/** @type {import('next').NextConfig} */
const nextConfig = {
  output: 'standalone',
  transpilePackages: ['three'],
  // Browsers and crawlers ask for these fixed addresses regardless of the <link> tags.
  async rewrites() {
    return [
      { source: '/favicon.ico', destination: '/favicon.svg' },
      { source: '/apple-touch-icon.png', destination: '/apple-icon' },
    ];
  },
  async redirects() {
    // Two posts lost "postgresql" from their slugs (feedback #140); old links and search results must keep working.
    return [
      { source: '/docs/embeddings', destination: '/docs/ai', permanent: true },
      { source: '/pricing', destination: '/#pricing', permanent: true },
      { source: '/blog/postgresql-row-level-security-guide', destination: '/blog/row-level-security-guide', permanent: true },
      { source: '/blog/rest-api-on-postgresql-without-boilerplate', destination: '/blog/rest-api-without-boilerplate', permanent: true },
    ];
  },
};

export default nextConfig;
