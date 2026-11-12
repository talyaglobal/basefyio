import type { MetadataRoute } from 'next';

export default function robots(): MetadataRoute.Robots {
  const siteUrl = process.env.NEXT_PUBLIC_APP_URL || 'https://app.basefyio.com';

  return {
    rules: [
      {
        userAgent: '*',
        allow: ['/', '/changelog', '/changelog/'],
        // A Disallow is a prefix: '/dashboard' covers /dashboard itself and everything under it.
        disallow: [
          '/dashboard',
          '/console',
          '/api/',
          '/auth/',
          '/cli-authorize',
          '/set-new-password',
          '/forgot-password',
          '/reset-password',
        ],
      },
    ],
    sitemap: `${siteUrl}/sitemap.xml`,
  };
}
