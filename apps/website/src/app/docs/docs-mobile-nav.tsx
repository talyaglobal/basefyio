"use client";

import { useEffect, useState } from "react";
import { usePathname } from "next/navigation";
import { Menu, X } from "lucide-react";
import { DocsNav } from "./docs-nav";
import { DocsSearch } from "./docs-search";

/**
 * Below the md breakpoint the sidebar is hidden, so this button opens the same
 * search and navigation in a drawer. It closes on navigation and on Escape.
 */
export function DocsMobileNav() {
  const [open, setOpen] = useState(false);
  const pathname = usePathname();

  useEffect(() => {
    setOpen(false);
  }, [pathname]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open]);

  return (
    <div className="md:hidden">
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-label="Open documentation menu"
        aria-expanded={open}
        aria-controls="docs-mobile-drawer"
        className="inline-flex h-9 w-9 items-center justify-center rounded-md border border-border text-foreground transition-colors hover:bg-secondary"
      >
        <Menu className="h-4 w-4" />
      </button>

      {open && (
        <div className="fixed inset-0 z-[60]" role="dialog" aria-modal="true" aria-label="Documentation menu">
          <button
            type="button"
            aria-label="Close documentation menu"
            className="absolute inset-0 bg-black/40"
            onClick={() => setOpen(false)}
          />
          <div
            id="docs-mobile-drawer"
            className="absolute inset-y-0 left-0 w-72 max-w-[85vw] overflow-y-auto border-r border-border bg-background p-4 shadow-xl"
          >
            <div className="mb-4 flex items-center justify-between">
              <span className="text-sm font-medium">Documentation</span>
              <button
                type="button"
                onClick={() => setOpen(false)}
                aria-label="Close documentation menu"
                className="inline-flex h-8 w-8 items-center justify-center rounded-md hover:bg-secondary"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
            <DocsSearch />
            <DocsNav />
          </div>
        </div>
      )}
    </div>
  );
}
