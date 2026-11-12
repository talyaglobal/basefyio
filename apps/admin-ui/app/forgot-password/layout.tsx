import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'Forgot Password',
  // Account-recovery pages are not search results.
  robots: { index: false, follow: false },
  description: 'Reset your basefyio account password.',
};

export default function ForgotPasswordLayout({ children }: { children: React.ReactNode }) {
  return children;
}
