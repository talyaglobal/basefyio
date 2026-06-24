"use client";

import { useMemo, useRef, useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import { Search, X } from "lucide-react";
import { DOCS_NAV_ITEMS } from "./docs-nav-items";

/**
 * Lightweight docs search over the shared nav source (page titles + curated
 * keywords). Filters as you type and navigates to the matching page. No
 * backend or external index needed.
 */
export function DocsSearch() {
  const router = useRouter();
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const containerRef = useRef<HTMLDivElement>(null);

  const results = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return [];
    return DOCS_NAV_ITEMS.filter((item) => {
      const haystack = [item.label, ...(item.keywords ?? [])].join(" ").toLowerCase();
      return q.split(/\s+/).every((term) => haystack.includes(term));
    }).slice(0, 8);
  }, [query]);

  useEffect(() => {
    setActive(0);
  }, [query]);

  useEffect(() => {
    function onClick(e: MouseEvent) {
      if (!containerRef.current?.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", onClick);
    return () => document.removeEventListener("mousedown", onClick);
  }, []);

  function go(href: string) {
    setOpen(false);
    setQuery("");
    router.push(href);
  }

  function onKeyDown(e: React.KeyboardEvent) {
    if (e.key === "Escape") {
      setOpen(false);
      return;
    }
    if (!results.length) return;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive((a) => (a + 1) % results.length);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((a) => (a - 1 + results.length) % results.length);
    } else if (e.key === "Enter") {
      e.preventDefault();
      go(results[active].href);
    }
  }

  return (
    <div ref={containerRef} className="relative mb-4">
      <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
      <input
        type="text"
        value={query}
        onChange={(e) => {
          setQuery(e.target.value);
          setOpen(true);
        }}
        onFocus={() => query && setOpen(true)}
        onKeyDown={onKeyDown}
        placeholder="Search docs…"
        className="h-9 w-full rounded-md border border-border bg-background pl-8 pr-7 text-sm focus:outline-none focus:ring-2 focus:ring-primary/40"
        aria-label="Search documentation"
      />
      {query && (
        <button
          type="button"
          onClick={() => {
            setQuery("");
            setOpen(false);
          }}
          className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
          aria-label="Clear search"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      )}

      {open && query.trim() && (
        <div className="absolute left-0 right-0 top-full z-30 mt-1 overflow-hidden rounded-md border border-border bg-card shadow-lg">
          {results.length === 0 ? (
            <p className="px-3 py-3 text-xs text-muted-foreground">No matches for “{query}”.</p>
          ) : (
            results.map((item, i) => (
              <button
                key={item.href}
                type="button"
                onMouseEnter={() => setActive(i)}
                onClick={() => go(item.href)}
                className={`block w-full px-3 py-2 text-left text-sm transition-colors ${
                  i === active ? "bg-primary/10 text-primary" : "text-foreground hover:bg-accent"
                }`}
              >
                {item.label}
              </button>
            ))
          )}
        </div>
      )}
    </div>
  );
}
