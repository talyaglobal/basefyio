'use client';

import type { ProjectActivityItem } from '@/lib/types';
import { cn } from '@/lib/utils';

const KIND_LABELS: Record<string, string> = {
  'supabase_import.completed': 'Supabase import',
  'supabase_import.failed': 'Supabase import',
  'supabase_import.cancelled': 'Supabase import',
  'project.created': 'Project',
  'project.updated': 'Project',
  'project.deleted': 'Project',
  'project.restored': 'Project',
  'project.permanent_delete': 'Project',
  'project.moved_team': 'Project',
  'sql.executed': 'SQL',
  'sql.failed': 'SQL',
  'integration.github_connected': 'GitHub',
  'integration.github_disconnected': 'GitHub',
  'integration.vercel_connected': 'Vercel',
  'integration.vercel_disconnected': 'Vercel',
  'auth.config_updated': 'Auth',
  'table.created': 'Database',
  'table.dropped': 'Database',
  'table.row_inserted': 'Database',
  'table.row_updated': 'Database',
  'table.row_deleted': 'Database',
  'table.column_added': 'Database',
  'table.column_updated': 'Database',
  'table.column_deleted': 'Database',
  'table.foreign_key_added': 'Database',
  'table.foreign_key_deleted': 'Database',
  'storage.bucket_created': 'Storage',
  'storage.bucket_updated': 'Storage',
  'storage.bucket_deleted': 'Storage',
  'storage.object_uploaded': 'Storage',
  'storage.object_deleted': 'Storage',
  'auth.user_created': 'Auth',
  'auth.user_updated': 'Auth',
  'auth.user_password_reset': 'Auth',
  'auth.user_deleted': 'Auth',
};

function categoryForKind(kind: string): string {
  return KIND_LABELS[kind] ?? kind.split('.')[0] ?? kind;
}

export interface ProjectActivityTimelineProps {
  items: ProjectActivityItem[];
  className?: string;
}

export function ProjectActivityTimeline({
  items,
  className,
}: ProjectActivityTimelineProps) {
  if (items.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        No activity recorded yet. Imports, edits, SQL, and integrations will
        show up here.
      </p>
    );
  }

  return (
    <ul className={cn('space-y-0', className)}>
      {items.map((item) => (
        <li
          key={item.id}
          className="relative flex gap-4 border-l border-border pb-6 pl-5 last:pb-0"
        >
          <span
            className="absolute -left-1.5 top-1.5 h-3 w-3 rounded-full border-2 border-background bg-primary"
            aria-hidden
          />
          <div className="min-w-0 flex-1 space-y-1">
            <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
              <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                {categoryForKind(item.kind)}
              </span>
              <time
                className="text-xs text-muted-foreground"
                dateTime={item.createdAt}
              >
                {new Date(item.createdAt).toLocaleString()}
              </time>
              <span className="text-xs text-muted-foreground">
                by {item.actorName || (item.userId ? item.userId : 'System')}
              </span>
            </div>
            <p className="text-sm font-medium text-foreground">{item.title}</p>
            {item.detail ? (
              <p className="whitespace-pre-wrap break-words text-xs text-muted-foreground">
                {item.detail}
              </p>
            ) : null}
          </div>
        </li>
      ))}
    </ul>
  );
}
