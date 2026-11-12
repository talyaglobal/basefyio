/** @type {import('next').NextConfig} */
const nextConfig = {
  output: 'standalone',
  transpilePackages: ['three'],
  async rewrites() {
    return [
      // Browsers and crawlers request these fixed paths whether or not the page
      // links an icon; without them both answered 404.
      { source: '/favicon.ico', destination: '/favicon.svg' },
      { source: '/apple-touch-icon.png', destination: '/apple-icon' },
      { source: '/apple-touch-icon-precomposed.png', destination: '/apple-icon' },
    ];
  },
};

export default nextConfig;
