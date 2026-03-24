import type { Metadata } from 'next';
import { Inter } from 'next/font/google';
import { Toaster } from 'sonner';
import { ImportProgressProvider } from '@/lib/import-progress-context';
import { ImportProgressToast } from '@/components/import-progress-toast';
import './globals.css';

const inter = Inter({ subsets: ['latin'] });

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
      <body className={inter.className}>
        <ImportProgressProvider>
          {children}
          <ImportProgressToast />
        </ImportProgressProvider>
        <Toaster position="bottom-right" richColors />
      </body>
    </html>
  );
}
