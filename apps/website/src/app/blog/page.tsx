import type { Metadata } from "next";
import Link from "next/link";
import { ArrowRight } from "lucide-react";
import { SiteShell } from "@/components/site-shell";
import { JsonLd } from "@/components/seo/json-ld";
import { buildMetadata } from "@/lib/seo/metadata";
import { itemListSchema } from "@/lib/seo/json-ld";
import { getSiteUrlFromRequest } from "@/lib/site-url";
import { getAllPosts } from "@/lib/content/blog";

const TITLE = "Blog";
const DESCRIPTION =
  "Guides, tutorials, and engineering notes on building backends with basefyio — PostgreSQL, auth, storage, REST APIs, SDK, and CLI.";

export async function generateMetadata(): Promise<Metadata> {
  return buildMetadata({
    path: "/blog",
    title: TITLE,
    description: DESCRIPTION,
    keywords: ["basefyio blog", "backend tutorials", "PostgreSQL guides"],
  });
}

function formatDate(date: string): string {
  return new Date(date).toLocaleDateString("en-US", {
    year: "numeric",
    month: "long",
    day: "numeric",
  });
}

export default async function BlogIndex() {
  const posts = getAllPosts();
  const base = (await getSiteUrlFromRequest()).replace(/\/$/, "");

  return (
    <SiteShell>
      <JsonLd
        data={itemListSchema(
          "basefyio Blog",
          posts.map((p) => ({
            name: p.title,
            url: `${base}/blog/${p.slug}`,
            description: p.description,
          })),
        )}
      />
      <div className="mx-auto max-w-3xl px-4 py-16 sm:px-6">
        <header className="mb-12">
          <h1 className="text-4xl font-bold tracking-tight">{TITLE}</h1>
          <p className="mt-3 text-lg text-muted-foreground">{DESCRIPTION}</p>
        </header>

        {posts.length === 0 ? (
          <p className="text-muted-foreground">No posts yet — check back soon.</p>
        ) : (
          <ul className="space-y-10">
            {posts.map((post) => (
              <li
                key={post.slug}
                className="group border-b border-border pb-10 last:border-0"
              >
                <Link href={`/blog/${post.slug}`} className="block">
                  <div className="flex items-center gap-3 text-xs text-muted-foreground">
                    <time dateTime={post.date}>{formatDate(post.date)}</time>
                    <span aria-hidden>·</span>
                    <span>{post.readingTime} min read</span>
                  </div>
                  <h2 className="mt-2 text-2xl font-semibold tracking-tight transition-colors group-hover:text-primary">
                    {post.title}
                  </h2>
                  <p className="mt-2 text-muted-foreground">
                    {post.description}
                  </p>
                  <span className="mt-3 inline-flex items-center gap-1 text-sm font-medium text-primary">
                    Read more
                    <ArrowRight className="h-4 w-4 transition-transform group-hover:translate-x-0.5" />
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </div>
    </SiteShell>
  );
}
