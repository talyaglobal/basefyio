import "server-only";
import fs from "node:fs";
import path from "node:path";
import matter from "gray-matter";
import { DEFAULT_AUTHOR } from "@/lib/seo/site";

const BLOG_DIR = path.join(process.cwd(), "src/content/blog");

export type BlogFrontmatter = {
  title: string;
  description: string;
  /** ISO date (YYYY-MM-DD). */
  date: string;
  updated?: string;
  author?: string;
  tags?: string[];
  /** Path or absolute URL of the share image. */
  image?: string;
  draft?: boolean;
};

export type BlogPostMeta = Required<
  Pick<BlogFrontmatter, "title" | "description" | "date" | "author">
> & {
  slug: string;
  updated?: string;
  tags: string[];
  image?: string;
  /** Rough reading time in minutes, derived from body length. */
  readingTime: number;
};

export type BlogPost = BlogPostMeta & { content: string };

function readingTime(body: string): number {
  const words = body.trim().split(/\s+/).length;
  return Math.max(1, Math.round(words / 200));
}

function listFiles(): string[] {
  if (!fs.existsSync(BLOG_DIR)) return [];
  return fs.readdirSync(BLOG_DIR).filter((f) => f.endsWith(".mdx"));
}

function parse(file: string): BlogPost {
  const slug = file.replace(/\.mdx$/, "");
  const raw = fs.readFileSync(path.join(BLOG_DIR, file), "utf8");
  const { data, content } = matter(raw);
  const fm = data as BlogFrontmatter;

  return {
    slug,
    title: fm.title,
    description: fm.description,
    date: fm.date,
    updated: fm.updated,
    author: fm.author ?? DEFAULT_AUTHOR,
    tags: fm.tags ?? [],
    image: fm.image,
    draft: fm.draft ?? false,
    readingTime: readingTime(content),
    content,
  } as BlogPost & { draft: boolean };
}

/** All published posts, newest first. Drafts are excluded in production. */
export function getAllPosts(): BlogPostMeta[] {
  const includeDrafts = process.env.NODE_ENV !== "production";
  return listFiles()
    .map(parse)
    .filter((p) => includeDrafts || !(p as BlogPost & { draft?: boolean }).draft)
    .sort((a, b) => (a.date < b.date ? 1 : -1))
    .map(({ content: _content, ...meta }) => meta);
}

export function getPostBySlug(slug: string): BlogPost | null {
  const file = `${slug}.mdx`;
  if (!listFiles().includes(file)) return null;
  return parse(file);
}

export function getAllSlugs(): string[] {
  return listFiles().map((f) => f.replace(/\.mdx$/, ""));
}
