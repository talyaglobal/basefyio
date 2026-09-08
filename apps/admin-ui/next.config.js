/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  output: 'standalone',
  serverExternalPackages: [],
  experimental: {
    serverActions: {
      bodySizeLimit: '10mb',
    },
  },
  // The root-only area was renamed from "Management" to "Admin". Old links
  // (bookmarks, emails already sent, OAuth callbacks) must keep working.
  async redirects() {
    return [
      { source: '/dashboard/management', destination: '/dashboard/admin', permanent: false },
      {
        source: '/dashboard/management/:path*',
        destination: '/dashboard/admin/:path*',
        permanent: false,
      },
    ];
  },
};

module.exports = nextConfig;
