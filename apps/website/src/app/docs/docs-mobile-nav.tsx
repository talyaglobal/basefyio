"use client";

import { useEffect, useState } from "react";
import { usePathname } from "next/navigation";
import { Menu, X } from "lucide-react";
import { DocsNav } from "./docs-nav";
import { DocsSearch } from "./docs-search";

/**
 * The docs sidebar for narrow screens. Below `md` the sidebar is hidden, so
 * without this there was no way to move between pages or search on a phone.
 * The drawer holds the same search and navigation, plus whatever the header
 * had to drop for space (passed as children). It closes on navigation, on
 * Escape and on a tap outside.
 */
export function DocsMobileNav({ children }: { children?: React.ReactNode }) {
  const [open, setOpen] = useState(false);
  const pathname = usePathname();

  useEffect(() => {
    setOpen(false);
  }, [pathname]);

  useEffect(() => {
    if (!open) return;
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => {
      document.body.style.overflow = previous;
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-label={open ? "Close documentation menu" : "Open documentation menu"}
        aria-expanded={open}
        aria-controls="docs-mobile-drawer"
        className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring md:hidden"
      >
        {open ? <X className="h-5 w-5" /> : <Menu className="h-5 w-5" />}
      </button>

      {open && (
        <div className="fixed inset-x-0 bottom-0 top-16 z-40 md:hidden">
          <div
            className="absolute inset-0 bg-background/70 backdrop-blur-sm"
            onClick={() => setOpen(false)}
            aria-hidden
          />
          <div
            id="docs-mobile-drawer"
            role="dialog"
            aria-modal="true"
            aria-label="Documentation menu"
            className="absolute bottom-0 left-0 top-0 w-72 max-w-[85vw] overflow-y-auto border-r border-border bg-card p-4 shadow-lg"
          >
            <DocsSearch />
            <DocsNav />
            {children && <div className="mt-6 border-t border-border pt-4">{children}</div>}
          </div>
        </div>
      )}
    </>
  );
}
