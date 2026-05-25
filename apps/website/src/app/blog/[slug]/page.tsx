import type { Metadata } from "next";
import { notFound } from "next/navigation";
import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { SiteShell } from "@/components/site-shell";
import { Breadcrumbs } from "@/components/seo/breadcrumbs";
import { JsonLd } from "@/components/seo/json-ld";
import { Mdx } from "@/components/mdx";
import { buildMetadata } from "@/lib/seo/metadata";
import { articleSchema } from "@/lib/seo/json-ld";
import { getSiteUrlFromRequest } from "@/lib/site-url";
import { getAllPosts, getAllSlugs, getPostBySlug } from "@/lib/content/blog";

type Params = { params: { slug: string } };

export function generateStaticParams() {
  return getAllSlugs().map((slug) => ({ slug }));
}

export async function generateMetadata({
  params,
}: Params): Promise<Metadata> {
  const post = getPostBySlug(params.slug);
  if (!post) return { title: "Not found", robots: { index: false } };

  return buildMetadata({
    path: `/blog/${post.slug}`,
    title: post.title,
    description: post.description,
    keywords: post.tags,
    image: post.image,
    type: "article",
    publishedTime: post.date,
    modifiedTime: post.updated ?? post.date,
    authors: [post.author],
  });
}

function formatDate(date: string): string {
  return new Date(date).toLocaleDateString("en-US", {
    year: "numeric",
    month: "long",
    day: "numeric",
  });
}

export default async function BlogPostPage({ params }: Params) {
  const post = getPostBySlug(params.slug);
  if (!post) notFound();

  const base = (await getSiteUrlFromRequest()).replace(/\/$/, "");
  const url = `${base}/blog/${post.slug}`;
  const related = getAllPosts()
    .filter((p) => p.slug !== post.slug)
    .slice(0, 3);

  return (
    <SiteShell>
      <JsonLd
        data={articleSchema({
          url,
          title: post.title,
          description: post.description,
          datePublished: post.date,
          dateModified: post.updated ?? post.date,
          authorName: post.author,
          image: post.image ? `${base}${post.image}` : undefined,
          siteUrl: base,
        })}
      />

      <article className="mx-auto max-w-3xl px-4 py-16 sm:px-6">
        <Breadcrumbs
          items={[
            { name: "Home", url: `${base}/` },
            { name: "Blog", url: `${base}/blog` },
            { name: post.title, url },
          ]}
        />

        <header className="mb-10">
          <div className="flex flex-wrap items-center gap-3 text-sm text-muted-foreground">
            <time dateTime={post.date}>{formatDate(post.date)}</time>
            <span aria-hidden>·</span>
            <span>{post.readingTime} min read</span>
            <span aria-hidden>·</span>
            <span>{post.author}</span>
          </div>
          <h1 className="mt-4 text-4xl font-bold tracking-tight">
            {post.title}
          </h1>
          <p className="mt-4 text-lg text-muted-foreground">
            {post.description}
          </p>
          {post.tags.length > 0 && (
            <div className="mt-4 flex flex-wrap gap-2">
              {post.tags.map((tag) => (
                <span
                  key={tag}
                  className="rounded-full bg-secondary px-3 py-1 text-xs font-medium text-secondary-foreground"
                >
                  {tag}
                </span>
              ))}
            </div>
          )}
        </header>

        <div className="prose prose-neutral max-w-none dark:prose-invert prose-headings:scroll-mt-24 prose-a:text-primary prose-pre:bg-muted prose-pre:text-foreground">
          <Mdx source={post.content} />
        </div>

        {related.length > 0 && (
          <section className="mt-16 border-t border-border pt-8">
            <h2 className="mb-4 text-xl font-semibold tracking-tight">
              Keep reading
            </h2>
            <ul className="space-y-3">
              {related.map((r) => (
                <li key={r.slug}>
                  <Link
                    href={`/blog/${r.slug}`}
                    className="font-medium text-primary transition-colors hover:underline"
                  >
                    {r.title}
                  </Link>
                  <p className="text-sm text-muted-foreground">
                    {r.description}
                  </p>
                </li>
              ))}
            </ul>
          </section>
        )}

        <footer className="mt-12 border-t border-border pt-8">
          <Link
            href="/blog"
            className="inline-flex items-center gap-1.5 text-sm font-medium text-primary"
          >
            <ArrowLeft className="h-4 w-4" />
            Back to blog
          </Link>
        </footer>
      </article>
    </SiteShell>
  );
}
