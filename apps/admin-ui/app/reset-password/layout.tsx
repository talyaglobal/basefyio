import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'Reset Password',
  description: 'Set a new password for your Kolaybase account.',
};

export default function ResetPasswordLayout({ children }: { children: React.ReactNode }) {
  return children;
}
