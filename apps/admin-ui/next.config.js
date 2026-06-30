const path = require('path');

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // `standalone` emits a self-contained server bundle with traced deps.
  output: 'standalone',
  // admin-ui lives in a pnpm monorepo and depends on the @basefyio/sdk
  // workspace package. Point file tracing at the repo root so the standalone
  // bundle includes the symlinked workspace dependency instead of a dangling
  // node_modules link. This also makes the bundle layout repo-root-relative,
  // so the entrypoint becomes apps/admin-ui/server.js.
  outputFileTracingRoot: path.join(__dirname, '../../'),
};

module.exports = nextConfig;
