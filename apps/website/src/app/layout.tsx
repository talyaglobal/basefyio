import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Kolaybase | Backend as a Service",
  description:
    "Kolaybase ile veritabanı, kimlik doğrulama ve REST API'yi dakikalar içinde kurun. No-code backend platformu.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="tr">
      <body className="antialiased min-h-screen bg-[#0a0f1a] text-slate-200">
        {children}
      </body>
    </html>
  );
}
