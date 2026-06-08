import type { Metadata } from "next";
import "@fontsource/inter/400.css";
import "@fontsource/inter/500.css";
import "@fontsource/inter/600.css";
import "@fontsource/inter/700.css";
import { ThemeProvider } from "@/components/theme-provider";
import { GoogleAnalytics } from "@/components/google-analytics";
import { SiteJsonLd } from "@/components/site-json-ld";
import { getSiteUrlFromRequest } from "@/lib/site-url";
import "./globals.css";

const defaultTitle =
  "basefyio — PostgreSQL BaaS & REST API for Developers";
const defaultDescription =
  "basefyio: hosted PostgreSQL, auth, storage, and auto REST API for developers. SDK, CLI, PostgREST-style queries. Ship backends in minutes.";

export async function generateMetadata(): Promise<Metadata> {
  const siteUrl = await getSiteUrlFromRequest();
  const metadataBase = new URL(siteUrl);

  return {
    metadataBase,
    title: {
      default: defaultTitle,
      template: "%s | basefyio",
    },
    description: defaultDescription,
    applicationName: "basefyio",
    alternates: {
      types: {
        "application/rss+xml": [{ url: "/feed.xml", title: "basefyio Blog" }],
      },
    },
    keywords: [
      "basefyio",
      "backend as a service",
      "BaaS",
      "developer backend",
      "PostgreSQL API",
      "REST API",
      "JavaScript SDK",
      "TypeScript SDK",
      "authentication API",
      "hosted postgres",
      "PostgREST compatible",
      "hosted PostgreSQL",
      "no-code backend",
      "CLI database",
    ],
    authors: [{ name: "basefyio" }],
    creator: "basefyio",
    openGraph: {
      type: "website",
      locale: "en_US",
      siteName: "basefyio",
      url: siteUrl,
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
    ...(process.env.NEXT_PUBLIC_GOOGLE_SITE_VERIFICATION
      ? {
          verification: {
            google: process.env.NEXT_PUBLIC_GOOGLE_SITE_VERIFICATION,
          },
        }
      : {}),
  };
}

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body
        className="font-sans antialiased min-h-screen bg-background text-foreground"
      >
        <GoogleAnalytics />
        <ThemeProvider>
          <SiteJsonLd />
          {children}
        </ThemeProvider>
      </body>
    </html>
  );
}
