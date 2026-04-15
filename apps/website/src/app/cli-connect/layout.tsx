import type { Metadata } from "next";
import { withAbsoluteSiteUrls } from "@/lib/absolute-site-metadata";

export async function generateMetadata(): Promise<Metadata> {
  return withAbsoluteSiteUrls("/cli-connect", {
    title: "Connect CLI",
    description:
      "Authorize the Kolaybase CLI to access your account from the terminal (browser flow).",
    robots: {
      index: false,
      follow: false,
    },
  });
}

export default function CliConnectLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return children;
}
