'use client';

import { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import { useDashboard } from '@/app/dashboard/layout';
import { api } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { MarkdownView } from '@/components/markdown-view';
import { ArrowLeft, RefreshCw } from 'lucide-react';

export function ManagementDocPage({
  slug,
  fallbackTitle,
}: {
  slug: string;
  fallbackTitle: string;
}) {
  const { profile } = useDashboard();
  const router = useRouter();
  const isRoot = profile?.role === 'ROOT';

  const [doc, setDoc] = useState<{ title: string; content: string; updatedAt: string | null } | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setDoc(await api.billing.managementDoc(slug));
    } catch (err: any) {
      toast.error(err.message || 'Failed to load');
    } finally {
      setLoading(false);
    }
  }, [slug]);

  useEffect(() => {
    // ROOT-only page; bounce others.
    if (profile && !isRoot) {
      router.replace('/dashboard');
      return;
    }
    if (isRoot) load();
  }, [profile, isRoot, load, router]);

  if (!profile || !isRoot) return null;

  return (
    <div className="mx-auto max-w-4xl space-y-4 p-6">
      <div className="flex items-center justify-between">
        <button onClick={() => router.push('/dashboard/management')} className="flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
          <ArrowLeft className="h-4 w-4" /> Management
        </button>
        <Button variant="outline" size="sm" onClick={load}><RefreshCw className="mr-2 h-3.5 w-3.5" />Refresh</Button>
      </div>

      {loading ? (
        <div className="flex justify-center py-16"><div className="h-6 w-6 animate-spin rounded-full border-2 border-muted border-t-foreground" /></div>
      ) : !doc?.content ? (
        <div className="rounded-lg border border-dashed py-16 text-center text-sm text-muted-foreground">
          {fallbackTitle} plan is empty.
        </div>
      ) : (
        <article className="rounded-lg border bg-card p-6">
          <MarkdownView md={doc.content} />
        </article>
      )}
    </div>
  );
}
