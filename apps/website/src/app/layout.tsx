import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Kolaybase | Backend as a Service",
  description:
    "Set up database, authentication, and REST API in minutes. No-code backend platform.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body className="antialiased min-h-screen bg-background text-foreground">
        {children}
      </body>
    </html>
  );
}
