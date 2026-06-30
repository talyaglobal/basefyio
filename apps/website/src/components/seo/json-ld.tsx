/**
 * Renders a JSON-LD <script> from a plain object produced by the builders in
 * `@/lib/seo/json-ld`. Use one per schema block on a page.
 */
export function JsonLd({ data }: { data: Record<string, unknown> }) {
  return (
    <script
      type="application/ld+json"
      dangerouslySetInnerHTML={{ __html: JSON.stringify(data) }}
    />
  );
}
