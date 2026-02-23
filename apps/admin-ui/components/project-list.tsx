'use client';

import Link from 'next/link';
import type { ProjectListItem } from '@/lib/types';
import { Badge } from '@/components/ui/badge';
import { Database, ArrowRight } from 'lucide-react';

interface ProjectListProps {
  projects: ProjectListItem[];
  loading: boolean;
  onRefresh: () => void;
}

export function ProjectList({ projects, loading }: ProjectListProps) {
  if (loading) {
    return (
      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
        {[1, 2, 3].map((i) => (
          <div
            key={i}
            className="h-40 animate-pulse rounded-lg border bg-card"
          />
        ))}
      </div>
    );
  }

  if (projects.length === 0) {
    return (
      <div className="flex h-64 flex-col items-center justify-center rounded-lg border border-dashed">
        <Database className="mb-4 h-12 w-12 text-muted-foreground/50" />
        <p className="text-lg font-medium">No projects yet</p>
        <p className="text-sm text-muted-foreground">
          Create your first project to get started.
        </p>
      </div>
    );
  }

  return (
    <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
      {projects.map((project) => (
        <Link
          key={project.id}
          href={`/dashboard/projects/${project.id}`}
          className="group rounded-lg border bg-card p-6 shadow-sm transition-shadow hover:shadow-md"
        >
          <div className="flex items-start justify-between">
            <div className="flex h-10 w-10 items-center justify-center rounded-md bg-primary/10">
              <Database className="h-5 w-5 text-primary" />
            </div>
            <Badge variant={project.status === 'ACTIVE' ? 'default' : 'secondary'}>
              {project.status}
            </Badge>
          </div>

          <h3 className="mt-4 text-lg font-semibold">{project.name}</h3>

          {project.description && (
            <p className="mt-1 line-clamp-2 text-sm text-muted-foreground">
              {project.description}
            </p>
          )}

          <div className="mt-4 flex items-center text-sm text-muted-foreground">
            <span>
              Created {new Date(project.createdAt).toLocaleDateString()}
            </span>
            <ArrowRight className="ml-auto h-4 w-4 opacity-0 transition-opacity group-hover:opacity-100" />
          </div>
        </Link>
      ))}
    </div>
  );
}
