
import type { NextConfig } from 'next';

/**
 * The browser only ever talks to this Next.js origin. Requests to /api/* are proxied
 * server-side to the NestJS API, so auth cookies are first-party and no API secret or
 * internal URL is exposed to the client. API_INTERNAL_URL is a server-only variable.
 */
const apiUrl = (process.env.API_INTERNAL_URL ?? 'http://localhost:4000').replace(/\/$/, '');

const securityHeaders = [
  { key: 'X-Frame-Options', value: 'DENY' },
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
  { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=()' },
];

const nextConfig: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  transpilePackages: ['@ctp/types'],
  async rewrites() {
    return [{ source: '/api/:path*', destination: `${apiUrl}/:path*` }];
  },
  async headers() {
    return [{ source: '/:path*', headers: securityHeaders }];
  },
};

export default nextConfig;
