import Link from "next/link";
import { SiteShell } from "@/components/site-shell";
import { docsUrl } from "@/lib/public-hosts";

export default function NotFound() {
  return (
    <SiteShell>
      <section className="mx-auto max-w-2xl px-4 py-24 text-center sm:px-6">
        <p className="text-sm font-medium text-primary">404</p>
        <h1 className="mt-2 text-3xl font-bold tracking-tight">This page does not exist</h1>
        <p className="mt-4 text-muted-foreground">
          The address may have changed or never existed. Try one of these instead.
        </p>
        <div className="mt-8 flex flex-wrap justify-center gap-3 text-sm">
          <Link href="/" className="rounded-lg bg-primary px-4 py-2 font-medium text-primary-foreground">Home</Link>
          <Link href={docsUrl()} className="rounded-lg border border-border px-4 py-2">Docs</Link>
          <Link href="/blog" className="rounded-lg border border-border px-4 py-2">Blog</Link>
        </div>
      </section>
    </SiteShell>
  );
}
