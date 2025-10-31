/** @type {import('next').NextConfig} */
const nextConfig = {
  typescript: {
    ignoreBuildErrors: false,
  },
  images: {
    unoptimized: true,
  },
  // Vercel optimization
  // Enable server components
  experimental: {
    serverActions: {
      bodySizeLimit: '10mb',
    },
  },
  // Remove turbopack config as it's causing font loading issues
  // Turbopack is experimental and can cause build issues
}

export default nextConfig
