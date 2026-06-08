import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'Sign Up',
  description: 'Create a free Basefyio account. Get started with your own backend platform in minutes.',
};

export default function SignupLayout({ children }: { children: React.ReactNode }) {
  return children;
}
