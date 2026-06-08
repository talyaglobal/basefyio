import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'Sign In',
  description: 'Sign in to your Basefyio account to manage your projects, databases, and team.',
};

export default function LoginLayout({ children }: { children: React.ReactNode }) {
  return children;
}
