"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Book, Code, Terminal, Server, Database, Shield, Cloud, Link2, Radio, KeyRound } from "lucide-react";
import { cn } from "@/lib/utils";
import type { LucideIcon } from "lucide-react";
import { DOCS_NAV_ITEMS } from "./docs-nav-items";

// Map the stable icon keys from the shared nav source to Lucide components
// (component references can't cross the server→client boundary, so we map here).
const ICONS: Record<string, LucideIcon> = {
  book: Book,
  database: Database,
  link: Link2,
  radio: Radio,
  key: KeyRound,
  server: Server,
  code: Code,
  terminal: Terminal,
  shield: Shield,
  cloud: Cloud,
};

export function DocsNav() {
  const pathname = usePathname();

  return (
    <nav className="space-y-1">
      {DOCS_NAV_ITEMS.map(({ href, label, icon }) => {
        const Icon = ICONS[icon] ?? Book;
        const isActive =
          href === "/docs"
            ? pathname === "/docs"
            : pathname.startsWith(href);

        return (
          <Link
            key={href}
            href={href}
            className={cn(
              "flex items-center gap-3 rounded-lg px-3 py-2 text-sm transition-colors",
              isActive
                ? "bg-primary/10 font-medium text-primary"
                : "text-muted-foreground hover:bg-accent hover:text-foreground",
            )}
          >
            <Icon className={cn("h-4 w-4", isActive && "text-primary")} />
            {label}
          </Link>
        );
      })}
    </nav>
  );
}
