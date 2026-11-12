import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'Reset Password',
  // Account-recovery pages are not search results.
  robots: { index: false, follow: false },
  description: 'Set a new password for your basefyio account.',
};

export default function ResetPasswordLayout({ children }: { children: React.ReactNode }) {
  return children;
}
