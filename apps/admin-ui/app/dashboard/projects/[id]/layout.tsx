'use client';

import { useEffect, useState } from 'react';
import { useParams, usePathname, useRouter } from 'next/navigation';
import Link from 'next/link';
import { toast } from 'sonner';
import { api } from '@/lib/api';
import type { Project } from '@/lib/types';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import {
  ArrowLeft,
  Database,
  FolderOpen,
  Key,
  Link2,
  Shield,
  Table2,
  Terminal,
} from 'lucide-react';

const navItems = [
  { label: 'Overview', href: '', icon: Database },
  { label: 'Table Editor', href: '/tables', icon: Table2 },
  { label: 'SQL Editor', href: '/sql', icon: Terminal },
  { label: 'Storage', href: '/storage', icon: FolderOpen },
  { label: 'Auth', href: '/auth', icon: Shield },
  { label: 'Connection', href: '/connect', icon: Link2 },
];

export default function ProjectLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const { id } = useParams<{ id: string }>();
  const pathname = usePathname();
  const router = useRouter();
  const [project, setProject] = useState<Project | null>(null);

  useEffect(() => {
    api.projects
      .get(id)
      .then(setProject)
      .catch((err) => {
        toast.error(err.message);
        router.push('/dashboard');
      });
  }, [id, router]);

  if (!project) {
    return (
      <div className="flex h-64 items-center justify-center">
        <div className="h-8 w-8 animate-spin rounded-full border-4 border-primary border-t-transparent" />
      </div>
    );
  }

  const basePath = `/dashboard/projects/${id}`;

  return (
    <div className="flex h-full gap-0 -m-6">
      <aside className="w-56 shrink-0 border-r bg-card">
        <div className="p-4 border-b">
          <Button
            variant="ghost"
            size="sm"
            className="mb-2 -ml-2 text-muted-foreground"
            onClick={() => router.push('/dashboard')}
          >
            <ArrowLeft className="mr-1.5 h-3.5 w-3.5" />
            Projects
          </Button>
          <div className="flex items-center gap-2">
            <div className="flex h-8 w-8 items-center justify-center rounded-md bg-primary/10">
              <Database className="h-4 w-4 text-primary" />
            </div>
            <div className="min-w-0">
              <p className="truncate text-sm font-semibold">{project.name}</p>
              <p className="truncate text-xs text-muted-foreground">{project.slug}</p>
            </div>
          </div>
        </div>

        <nav className="space-y-0.5 p-2">
          {navItems.map((item) => {
            const href = `${basePath}${item.href}`;
            const active =
              item.href === ''
                ? pathname === basePath
                : pathname.startsWith(href);

            return (
              <Link
                key={item.label}
                href={href}
                className={cn(
                  'flex items-center gap-2.5 rounded-md px-3 py-2 text-sm font-medium transition-colors',
                  active
                    ? 'bg-primary/10 text-primary'
                    : 'text-muted-foreground hover:bg-accent hover:text-accent-foreground',
                )}
              >
                <item.icon className="h-4 w-4" />
                {item.label}
              </Link>
            );
          })}
        </nav>

        <div className="mx-2 mt-4 rounded-md border bg-muted/30 p-3">
          <div className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
            <Key className="h-3 w-3" />
            API Keys
          </div>
          <p className="mt-1.5 truncate font-mono text-[10px] text-muted-foreground" title={project.anonKey}>
            anon: {project.anonKey}
          </p>
        </div>
      </aside>

      <main className="flex-1 overflow-y-auto p-6">{children}</main>
    </div>
  );
}
