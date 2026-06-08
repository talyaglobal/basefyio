import type { MetadataRoute } from 'next';
import { listChangelogEntries } from '@/lib/changelog';

export default function sitemap(): MetadataRoute.Sitemap {
  const siteUrl = process.env.NEXT_PUBLIC_APP_URL || 'https://app.basefyio.com';

  const staticPages: MetadataRoute.Sitemap = [
    { url: `${siteUrl}/login`, changeFrequency: 'monthly', priority: 0.8 },
    { url: `${siteUrl}/signup`, changeFrequency: 'monthly', priority: 0.8 },
    { url: `${siteUrl}/changelog`, changeFrequency: 'weekly', priority: 0.9 },
  ];

  const changelogEntries: MetadataRoute.Sitemap = listChangelogEntries().map((entry) => ({
    url: `${siteUrl}/changelog/${entry.slug}`,
    lastModified: new Date(entry.date + 'T00:00:00'),
    changeFrequency: 'monthly',
    priority: 0.7,
  }));

  return [...staticPages, ...changelogEntries];
}
