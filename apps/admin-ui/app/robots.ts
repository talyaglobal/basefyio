import type { MetadataRoute } from 'next';

export default function robots(): MetadataRoute.Robots {
  const siteUrl = process.env.NEXT_PUBLIC_APP_URL || 'https://app.kolaybase.com';

  return {
    rules: [
      {
        userAgent: '*',
        allow: ['/', '/changelog', '/changelog/'],
        disallow: ['/dashboard/', '/api/', '/cli-authorize'],
      },
    ],
    sitemap: `${siteUrl}/sitemap.xml`,
  };
}
