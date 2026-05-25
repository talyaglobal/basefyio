import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'Forgot Password',
  description: 'Reset your Kolaybase account password.',
};

export default function ForgotPasswordLayout({ children }: { children: React.ReactNode }) {
  return children;
}
