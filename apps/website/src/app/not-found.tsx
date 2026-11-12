import type { Metadata } from "next";
import Link from "next/link";
import { SiteShell } from "@/components/site-shell";

export const metadata: Metadata = {
  title: "Page not found",
  robots: { index: false, follow: true },
};

const DESTINATIONS = [
  { href: "/", label: "Home", desc: "What basefyio is and how it works" },
  { href: "/docs", label: "Documentation", desc: "Guides and the API reference" },
  { href: "/docs/quickstart", label: "Quickstart", desc: "Your first project in five minutes" },
  { href: "/pricing", label: "Pricing", desc: "Plans and limits" },
  { href: "/blog", label: "Blog", desc: "Guides and release notes" },
];

/** The site's 404: same header and footer as every page, and a way back in. */
export default function NotFound() {
  return (
    <SiteShell>
      <section className="mx-auto max-w-3xl px-6 py-24">
        <p className="font-mono text-sm text-muted-foreground">404</p>
        <h1 className="mt-2 text-3xl font-bold tracking-tight sm:text-4xl">This page does not exist</h1>
        <p className="mt-4 text-muted-foreground">
          The link may be old or mistyped. One of these is probably what you were after:
        </p>
        <ul className="mt-8 grid gap-3 sm:grid-cols-2">
          {DESTINATIONS.map((d) => (
            <li key={d.href}>
              <Link
                href={d.href}
                className="block rounded-xl border border-border bg-card p-4 transition-colors hover:border-muted-foreground/30"
              >
                <span className="font-semibold text-foreground">{d.label}</span>
                <span className="mt-1 block text-sm text-muted-foreground">{d.desc}</span>
              </Link>
            </li>
          ))}
        </ul>
      </section>
    </SiteShell>
  );
}
