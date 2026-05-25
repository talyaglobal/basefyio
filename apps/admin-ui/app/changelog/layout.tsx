import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'Changelog',
  description: 'Latest updates, new features, and improvements to Kolaybase. Stay up to date with what we ship.',
};

export default function ChangelogLayout({ children }: { children: React.ReactNode }) {
  return children;
}
