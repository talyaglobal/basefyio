import type { Metadata } from 'next';
import { PlaygroundProvider } from '@/components/playground/playground-provider';
import { PlaygroundNav } from '@/components/playground/playground-nav';
import { PlaygroundBanner } from '@/components/playground/playground-banner';

export const metadata: Metadata = {
  title: 'Playground',
  description:
    'Try basefyio in your browser — run SQL, browse tables, and explore the REST API. No signup, no install.',
};

export default function PlaygroundRouteLayout({ children }: { children: React.ReactNode }) {
  return (
    <PlaygroundProvider>
      <div className="flex h-screen flex-col overflow-hidden">
        <PlaygroundNav />
        <PlaygroundBanner />
        <div className="flex min-h-0 flex-1">{children}</div>
      </div>
    </PlaygroundProvider>
  );
}
