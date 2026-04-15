import type { Metadata } from "next";
import { Inter } from "next/font/google";
import { ThemeProvider } from "@/components/theme-provider";
import { SiteJsonLd } from "@/components/site-json-ld";
import { getSiteUrl } from "@/lib/site-url";
import "./globals.css";

const inter = Inter({ subsets: ["latin"], display: "swap" });

const siteUrl = getSiteUrl();
const defaultTitle = "Kolaybase | Backend as a Service";
const defaultDescription =
  "Set up database, authentication, and REST API in minutes. No-code backend platform.";

export const metadata: Metadata = {
  metadataBase: new URL(siteUrl),
  title: {
    default: defaultTitle,
    template: "%s | Kolaybase",
  },
  description: defaultDescription,
  applicationName: "Kolaybase",
  keywords: [
    "Kolaybase",
    "backend as a service",
    "BaaS",
    "PostgreSQL",
    "REST API",
    "authentication",
    "Supabase-compatible",
    "no-code backend",
  ],
  authors: [{ name: "Kolaybase" }],
  creator: "Kolaybase",
  openGraph: {
    type: "website",
    locale: "en_US",
    siteName: "Kolaybase",
    title: defaultTitle,
    description: defaultDescription,
  },
  twitter: {
    card: "summary_large_image",
    title: defaultTitle,
    description: defaultDescription,
  },
  robots: {
    index: true,
    follow: true,
    googleBot: {
      index: true,
      follow: true,
    },
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body
        className={`${inter.className} antialiased min-h-screen bg-background text-foreground`}
      >
        <ThemeProvider>
          <SiteJsonLd />
          {children}
        </ThemeProvider>
      </body>
    </html>
  );
}
