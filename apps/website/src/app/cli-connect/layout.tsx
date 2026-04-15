import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Connect CLI",
  description:
    "Authorize the Kolaybase CLI to access your account from the terminal (browser flow).",
  robots: {
    index: false,
    follow: false,
  },
};

export default function CliConnectLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return children;
}
