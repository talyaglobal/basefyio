import Link from "next/link";
import { ChevronRight } from "lucide-react";
import { breadcrumbSchema, type BreadcrumbItem } from "@/lib/seo/json-ld";
import { JsonLd } from "@/components/seo/json-ld";

/**
 * Visible breadcrumb trail that also emits BreadcrumbList structured data.
 * Pass absolute URLs (resolved from the request origin) so the schema is valid.
 * The last item is rendered as the current page (no link).
 */
export function Breadcrumbs({ items }: { items: BreadcrumbItem[] }) {
  return (
    <>
      <JsonLd data={breadcrumbSchema(items)} />
      <nav aria-label="Breadcrumb" className="mb-6">
        <ol className="flex flex-wrap items-center gap-1.5 text-sm text-muted-foreground">
          {items.map((item, i) => {
            const isLast = i === items.length - 1;
            return (
              <li key={item.url} className="flex items-center gap-1.5">
                {isLast ? (
                  <span className="text-foreground" aria-current="page">
                    {item.name}
                  </span>
                ) : (
                  <Link
                    href={new URL(item.url).pathname || "/"}
                    className="transition-colors hover:text-foreground"
                  >
                    {item.name}
                  </Link>
                )}
                {!isLast && (
                  <ChevronRight className="h-3.5 w-3.5 shrink-0" aria-hidden />
                )}
              </li>
            );
          })}
        </ol>
      </nav>
    </>
  );
}
