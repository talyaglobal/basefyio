import type { Metadata } from 'next';
import { Toaster } from 'sonner';
import { ImportProgressProvider } from '@/lib/import-progress-context';
import { ImportProgressToast } from '@/components/import-progress-toast';
import { ExportProgressProvider } from '@/lib/export-progress-context';
import { ExportProgressToast } from '@/components/export-progress-toast';
import { ThemeProvider } from '@/components/theme-provider';
import { NotificationsProvider } from '@/lib/notifications-context';
import './globals.css';

export const metadata: Metadata = {
  title: 'Kolaybase — Admin',
  description: 'Self-hosted backend platform control plane',
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
