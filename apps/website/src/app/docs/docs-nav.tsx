"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Book, Code, Terminal, Server, Database, Shield, Cloud, Link2, Radio } from "lucide-react";
import { cn } from "@/lib/utils";
import type { LucideIcon } from "lucide-react";

interface NavItem {
  href: string;
  label: string;
  icon: LucideIcon;
}

// Defined here (not in the server layout) because component references are
// not serializable across the server -> client boundary; passing them as
// props breaks static page generation.
const items: NavItem[] = [
  { href: "/docs", label: "Overview", icon: Book },
  { href: "/docs/data-engine", label: "Data Engine", icon: Database },
  { href: "/docs/connect", label: "Connect", icon: Link2 },
  { href: "/docs/realtime", label: "Realtime", icon: Radio },
  { href: "/docs/api", label: "API Reference", icon: Server },
  { href: "/docs/sdk", label: "SDK", icon: Code },
  { href: "/docs/cli", label: "CLI", icon: Terminal },
  { href: "/docs/security", label: "Security & RLS", icon: Shield },
  { href: "/docs/self-hosting", label: "Self-Hosting", icon: Cloud },
];

export function DocsNav() {
  const pathname = usePathname();

  return (
    <nav className="space-y-1">
      {items.map(({ href, label, icon: Icon }) => {
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
