'use client';

import { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';
import {
  BrainCircuit,
  Check,
  Copy,
  Database,
  Eye,
  EyeOff,
  Key,
  Loader2,
  Search,
  Sparkles,
} from 'lucide-react';
import { api } from '@/lib/api';
import { useProject } from '@/contexts/project-context';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Badge } from '@/components/ui/badge';

interface EmbeddingStatus {
  pgvectorEnabled: boolean;
  pgvectorEnabledAt: string | null;
  hasApiKey: boolean;
  embeddingCount: number | null;
}

export default function EmbeddingsPage() {
  const { project } = useProject();
  const [status, setStatus] = useState<EmbeddingStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [toggling, setToggling] = useState(false);
  const [apiKey, setApiKey] = useState('');
  const [savingKey, setSavingKey] = useState(false);
  const [showKey, setShowKey] = useState(false);
  const [keySaved, setKeySaved] = useState(false);

  const fetchStatus = useCallback(async () => {
    if (!project) return;
    try {
      const s = await api.embeddings.getStatus(project.id);
      setStatus(s);
    } catch (err: any) {
      toast.error(err.message || 'Failed to load embedding status');
    } finally {
      setLoading(false);
    }
  }, [project]);

  useEffect(() => {
    fetchStatus();
  }, [fetchStatus]);

  const handleToggle = async (enabled: boolean) => {
    if (!project) return;
    setToggling(true);
    try {
      if (enabled) {
        await api.embeddings.enable(project.id);
        toast.success('pgvector enabled on your project database');
      } else {
        await api.embeddings.disable(project.id);
        toast.success('pgvector disabled');
      }
      await fetchStatus();
    } catch (err: any) {
      toast.error(err.message || 'Failed to toggle pgvector');
    } finally {
      setToggling(false);
    }
  };

  const handleSaveApiKey = async () => {
    if (!project) return;
    setSavingKey(true);
    try {
      await api.embeddings.setApiKey(project.id, apiKey.trim() || null);
      toast.success(apiKey.trim() ? 'API key saved' : 'API key cleared');
      setKeySaved(true);
      setApiKey('');
      setTimeout(() => setKeySaved(false), 2000);
      await fetchStatus();
    } catch (err: any) {
      toast.error(err.message || 'Failed to save API key');
    } finally {
      setSavingKey(false);
    }
  };

  const copyToClipboard = async (text: string, label: string) => {
    try {
      await navigator.clipboard.writeText(text);
      toast.success(`${label} copied`);
    } catch {
      toast.error('Could not copy to clipboard');
    }
  };

  if (!project) return null;

  if (loading) {
    return (
      <div className="flex h-64 items-center justify-center">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  const apiBaseUrl = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:4000';

  return (
    <div className="mx-auto w-full max-w-3xl space-y-6">
      <div>
        <h1 className="text-2xl font-bold">AI / Embeddings</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Enable vector search on your project database to build semantic search, RAG, and AI-powered features.
        </p>
      </div>

      {/* Card 1: pgvector Toggle */}
      <div className="rounded-xl border bg-card p-6">
        <div className="flex items-start justify-between gap-4">
          <div className="flex items-start gap-3">
            <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-primary/10">
              <Database className="h-5 w-5 text-primary" />
            </div>
            <div>
              <h2 className="text-base font-semibold">Vector Search (pgvector)</h2>
              <p className="mt-0.5 text-sm text-muted-foreground">
                Enable the pgvector extension and embedding tables on your project's database.
              </p>
            </div>
          </div>
          <Switch
            checked={status?.pgvectorEnabled ?? false}
            onCheckedChange={handleToggle}
            disabled={toggling}
          />
        </div>

        {status?.pgvectorEnabled && (
          <div className="mt-4 flex flex-wrap items-center gap-3 border-t pt-4">
            <Badge variant="outline" className="gap-1.5">
              <Check className="h-3 w-3 text-emerald-500" />
              Enabled
            </Badge>
            {status.pgvectorEnabledAt && (
              <span className="text-xs text-muted-foreground">
                since{' '}
                {new Date(status.pgvectorEnabledAt).toLocaleDateString('en-US', {
                  year: 'numeric',
                  month: 'short',
                  day: 'numeric',
                })}
              </span>
            )}
            {status.embeddingCount != null && (
              <Badge variant="secondary" className="gap-1.5">
                <Sparkles className="h-3 w-3" />
                {status.embeddingCount.toLocaleString()} embeddings
              </Badge>
            )}
          </div>
        )}

        {toggling && (
          <div className="mt-4 flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" />
            {status?.pgvectorEnabled ? 'Disabling...' : 'Creating extension and tables...'}
          </div>
        )}
      </div>

      {/* Card 2: OpenAI API Key */}
      <div className="rounded-xl border bg-card p-6">
        <div className="flex items-start gap-3">
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-amber-500/10">
            <Key className="h-5 w-5 text-amber-600 dark:text-amber-400" />
          </div>
          <div className="flex-1">
            <h2 className="text-base font-semibold">OpenAI API Key</h2>
            <p className="mt-0.5 text-sm text-muted-foreground">
              Per-project key for generating embeddings. If not set, the platform-level key is used.
            </p>
          </div>
          {status?.hasApiKey && (
            <Badge variant="outline" className="shrink-0 gap-1.5">
              <Check className="h-3 w-3 text-emerald-500" />
              Key available
            </Badge>
          )}
        </div>

        <div className="mt-4 space-y-2">
          <Label htmlFor="embedding-api-key">API Key</Label>
          <div className="flex gap-2">
            <div className="relative flex-1">
              <Input
                id="embedding-api-key"
                type={showKey ? 'text' : 'password'}
                placeholder="sk-..."
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
                className="pr-10"
              />
              <button
                type="button"
                onClick={() => setShowKey(!showKey)}
                className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
              >
                {showKey ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
              </button>
            </div>
            <Button onClick={handleSaveApiKey} disabled={savingKey}>
              {savingKey ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : keySaved ? (
                <Check className="h-4 w-4" />
              ) : (
                'Save'
              )}
            </Button>
          </div>
          <p className="text-xs text-muted-foreground">
            Leave empty and click Save to clear the per-project key and fall back to the platform key.
          </p>
        </div>
      </div>

      {/* Card 3: API Usage Guide */}
      {status?.pgvectorEnabled && (
        <div className="rounded-xl border bg-card p-6">
          <div className="flex items-start gap-3">
            <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-blue-500/10">
              <BrainCircuit className="h-5 w-5 text-blue-600 dark:text-blue-400" />
            </div>
            <div>
              <h2 className="text-base font-semibold">API Reference</h2>
              <p className="mt-0.5 text-sm text-muted-foreground">
                Use these endpoints from your application to store and search embeddings.
              </p>
            </div>
          </div>

          <div className="mt-5 space-y-4">
            {/* Endpoints */}
            <div className="space-y-2">
              <h3 className="text-sm font-medium">Endpoints</h3>
              <div className="space-y-1.5">
                {[
                  { method: 'POST', path: '/rest/v1/embeddings', desc: 'Store an embedding' },
                  { method: 'POST', path: '/rest/v1/embeddings/batch', desc: 'Store multiple embeddings' },
                  { method: 'POST', path: '/rest/v1/embeddings/search', desc: 'Semantic search' },
                  { method: 'DELETE', path: '/rest/v1/embeddings', desc: 'Delete by IDs' },
                  { method: 'GET', path: '/rest/v1/embeddings/status', desc: 'Check status' },
                ].map((ep) => (
                  <div key={ep.path + ep.method} className="flex items-center gap-2 text-sm">
                    <span className="w-16 shrink-0 rounded bg-muted px-1.5 py-0.5 text-center text-xs font-mono font-medium">
                      {ep.method}
                    </span>
                    <code className="text-xs text-muted-foreground">{ep.path}</code>
                    <span className="ml-auto text-xs text-muted-foreground">{ep.desc}</span>
                  </div>
                ))}
              </div>
            </div>

            {/* API Keys */}
            <div className="space-y-2">
              <h3 className="text-sm font-medium">Your API Keys</h3>
              <div className="space-y-1.5">
                <div className="flex items-center gap-2">
                  <span className="w-24 shrink-0 text-xs text-muted-foreground">anon key</span>
                  <code className="flex-1 truncate rounded bg-muted px-2 py-1 text-xs">{project.anonKey}</code>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-7 w-7 shrink-0"
                    onClick={() => copyToClipboard(project.anonKey, 'Anon key')}
                  >
                    <Copy className="h-3.5 w-3.5" />
                  </Button>
                </div>
                <div className="flex items-center gap-2">
                  <span className="w-24 shrink-0 text-xs text-muted-foreground">service key</span>
                  <code className="flex-1 truncate rounded bg-muted px-2 py-1 text-xs">{project.serviceKey}</code>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-7 w-7 shrink-0"
                    onClick={() => copyToClipboard(project.serviceKey, 'Service key')}
                  >
                    <Copy className="h-3.5 w-3.5" />
                  </Button>
                </div>
              </div>
            </div>

            {/* Quick Start */}
            <div className="space-y-2">
              <h3 className="text-sm font-medium">Quick Start</h3>
              <div className="relative">
                <pre className="overflow-x-auto rounded-lg bg-muted p-4 text-xs leading-relaxed">
                  <code>{`// Store an embedding
const res = await fetch('${apiBaseUrl}/rest/v1/embeddings', {
  method: 'POST',
  headers: {
    'apikey': '${project.serviceKey.slice(0, 20)}...',
    'Content-Type': 'application/json',
  },
  body: JSON.stringify({
    content: 'How to reset my password?',
    namespace: 'faq',
    metadata: { category: 'auth' },
  }),
});

// Search similar content
const results = await fetch('${apiBaseUrl}/rest/v1/embeddings/search', {
  method: 'POST',
  headers: {
    'apikey': '${project.anonKey.slice(0, 20)}...',
    'Content-Type': 'application/json',
  },
  body: JSON.stringify({
    query: 'forgot my password',
    namespace: 'faq',
    limit: 5,
  }),
});`}</code>
                </pre>
                <Button
                  variant="ghost"
                  size="icon"
                  className="absolute right-2 top-2 h-7 w-7"
                  onClick={() =>
                    copyToClipboard(
                      `// Store an embedding
const res = await fetch('${apiBaseUrl}/rest/v1/embeddings', {
  method: 'POST',
  headers: {
    'apikey': '<YOUR_SERVICE_KEY>',
    'Content-Type': 'application/json',
  },
  body: JSON.stringify({
    content: 'How to reset my password?',
    namespace: 'faq',
    metadata: { category: 'auth' },
  }),
});

// Search similar content
const results = await fetch('${apiBaseUrl}/rest/v1/embeddings/search', {
  method: 'POST',
  headers: {
    'apikey': '<YOUR_ANON_KEY>',
    'Content-Type': 'application/json',
  },
  body: JSON.stringify({
    query: 'forgot my password',
    namespace: 'faq',
    limit: 5,
  }),
});`,
                      'Code snippet',
                    )
                  }
                >
                  <Copy className="h-3.5 w-3.5" />
                </Button>
              </div>
            </div>

            {/* How it works */}
            <div className="rounded-lg bg-muted/50 p-4">
              <h3 className="text-sm font-medium">How it works</h3>
              <ul className="mt-2 space-y-1.5 text-xs text-muted-foreground">
                <li className="flex items-start gap-2">
                  <Search className="mt-0.5 h-3 w-3 shrink-0" />
                  <span>Text is converted to a 1536-dimensional vector using OpenAI's <code className="rounded bg-background px-1">text-embedding-3-small</code> model</span>
                </li>
                <li className="flex items-start gap-2">
                  <Database className="mt-0.5 h-3 w-3 shrink-0" />
                  <span>Vectors are stored in your project's PostgreSQL database using pgvector with HNSW indexing</span>
                </li>
                <li className="flex items-start gap-2">
                  <Sparkles className="mt-0.5 h-3 w-3 shrink-0" />
                  <span>Search finds semantically similar content using cosine distance — no exact keyword match needed</span>
                </li>
              </ul>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
