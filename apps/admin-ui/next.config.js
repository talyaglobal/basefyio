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
  // Signed-in pages and the password flows are an app shell for one visitor: keep them out
  // of shared caches and search indexes (feedback #143). Next's default for a static page
  // is s-maxage=31536000, which a CDN would honour. The session itself lives in the browser
  // (see middleware.ts), so there is deliberately no server-side redirect to /login.
  async headers() {
    const headers = [
      { key: 'Cache-Control', value: 'private, no-cache, must-revalidate' },
      { key: 'X-Robots-Tag', value: 'noindex, nofollow' },
    ];
    return ['/dashboard/:path*', '/forgot-password', '/reset-password', '/set-new-password'].map((source) => ({
      source,
      headers,
    }));
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
