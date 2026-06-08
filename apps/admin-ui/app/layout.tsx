import type { Metadata } from 'next';
import { Toaster } from 'sonner';
import { ImportProgressProvider } from '@/lib/import-progress-context';
import { ImportProgressToast } from '@/components/import-progress-toast';
import { ExportProgressProvider } from '@/lib/export-progress-context';
import { ExportProgressToast } from '@/components/export-progress-toast';
import { ThemeProvider } from '@/components/theme-provider';
import { NotificationsProvider } from '@/lib/notifications-context';
import { GlobalErrorCatcher } from '@/components/global-error-catcher';
import './globals.css';

const APP_URL = process.env.NEXT_PUBLIC_APP_URL || 'https://app.basefyio.com';
const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL || 'https://basefyio.com';

export const metadata: Metadata = {
  title: {
    default: 'Basefyio — Open Source Backend Platform',
    template: '%s | Basefyio',
  },
  description:
    'Self-hosted backend platform with database management, authentication, storage, real-time APIs, and team collaboration. An open-source alternative to Firebase and Supabase.',
  metadataBase: new URL(APP_URL),
  icons: {
    icon: '/icon.svg',
    apple: '/icon.svg',
  },
  openGraph: {
    type: 'website',
    siteName: 'Basefyio',
    title: 'Basefyio — Open Source Backend Platform',
    description:
      'Self-hosted backend platform with database management, authentication, storage, real-time APIs, and team collaboration.',
    url: SITE_URL,
  },
  twitter: {
    card: 'summary',
    title: 'Basefyio — Open Source Backend Platform',
    description:
      'Self-hosted backend platform with database management, authentication, storage, real-time APIs, and team collaboration.',
  },
  robots: {
    index: true,
    follow: true,
  },
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
        <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet" />
      </head>
      <body style={{ fontFamily: "'Inter', sans-serif" }}>
        <GlobalErrorCatcher />
        <ThemeProvider>
          <ImportProgressProvider>
            <ExportProgressProvider>
              <NotificationsProvider>
                {children}
                <ImportProgressToast />
                <ExportProgressToast />
              </NotificationsProvider>
            </ExportProgressProvider>
          </ImportProgressProvider>
          <Toaster position="bottom-right" richColors />
        </ThemeProvider>
      </body>
    </html>
  );
}
