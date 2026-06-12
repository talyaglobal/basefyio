/** @type {import('next').NextConfig} */
const nextConfig = {
  env: {
    PLATFORM_API_URL: process.env.PLATFORM_API_URL || 'http://localhost:3000',
  },
};
export default nextConfig;
