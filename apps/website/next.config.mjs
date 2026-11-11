/** @type {import('next').NextConfig} */
const nextConfig = {
  output: 'standalone',
  transpilePackages: ['three'],
  async redirects() {
    // Two posts lost "postgresql" from their slugs (feedback #140); old links and search results must keep working.
    return [
      { source: '/pricing', destination: '/#pricing', permanent: true },
      { source: '/blog/postgresql-row-level-security-guide', destination: '/blog/row-level-security-guide', permanent: true },
      { source: '/blog/rest-api-on-postgresql-without-boilerplate', destination: '/blog/rest-api-without-boilerplate', permanent: true },
    ];
  },
};

export default nextConfig;
