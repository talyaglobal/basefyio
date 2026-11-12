'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';
import {
  BrainCircuit,
  Check,
  Copy,
  Database,
  Eye,
  EyeOff,
  Globe,
  Key,
  Loader2,
  RefreshCw,
  Search,
  Server,
  Sparkles,
} from 'lucide-react';
import { api } from '@/lib/api';
import type {
  EmbeddingDisclosure,
  EmbeddingProviderCatalogue,
  EmbeddingStatus,
  SetEmbeddingProviderBody,
} from '@/lib/embeddings';
import { useProject } from '@/contexts/project-context';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Badge } from '@/components/ui/badge';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { confirmDialog } from '@/components/ui/confirm-dialog';
import { AiModelSettings } from '@/components/ai/ai-model-settings';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';

/** Select value meaning "no project override — follow the platform setting". */
const PLATFORM_DEFAULT = '__platform__';
const REEMBED_POLL_MS = 5000;

/** How each provider's key looks and where to get one, for the key card. */
const KEY_HINTS: Record<string, { placeholder: string; help: string }> = {
  openai: {
    placeholder: 'sk-...',
    help: 'Create one under API keys at platform.openai.com.',
  },
  cohere: {
    placeholder: 'Cohere API key',
    help: 'Create one under API keys in the Cohere dashboard.',
  },
  gemini: {
    placeholder: 'AIza...',
    help: 'Create one with "Get API key" in Google AI Studio (aistudio.google.com).',
  },
  ollama: {
    placeholder: 'Bearer token (optional)',
    help: 'Only needed when the Ollama host sits behind an authenticating proxy.',
  },
};

/** Key test failures the API lets the caller override with `skipValidation`. */
const SKIPPABLE_KEY_ERRORS = new Set(['EMBEDDING_PROVIDER_UNREACHABLE', 'EMBEDDING_API_KEY_TEST_FAILED']);

function plural(n: number, word: string): string {
  return `${n.toLocaleString()} ${word}${n === 1 ? '' : 's'}`;
}

export default function EmbeddingsPage() {
  const { project } = useProject();
  const [status, setStatus] = useState<EmbeddingStatus | null>(null);
  const [disclosure, setDisclosure] = useState<EmbeddingDisclosure | null>(null);
  const [catalogue, setCatalogue] = useState<EmbeddingProviderCatalogue | null>(null);
  const [loading, setLoading] = useState(true);
  const [toggling, setToggling] = useState(false);
  // Disable confirmation: keep the stored embeddings (default) or delete them.
  const [disableOpen, setDisableOpen] = useState(false);
  const [dropData, setDropData] = useState(false);
  const [apiKey, setApiKey] = useState('');
  const [savingKey, setSavingKey] = useState(false);
  const [showKey, setShowKey] = useState(false);
  const [keySaved, setKeySaved] = useState(false);
  // Provider form
  const [providerSel, setProviderSel] = useState(PLATFORM_DEFAULT);
  const [model, setModel] = useState('');
  const [baseUrl, setBaseUrl] = useState('');
  const [formSeeded, setFormSeeded] = useState(false);
  const [savingProvider, setSavingProvider] = useState(false);
  const [reembedding, setReembedding] = useState(false);
  // Public REST base (`<public api>/api/rest/v1`) as the backend reports it —
  // the global `/api` prefix and the production host are only known there.
  const [restUrl, setRestUrl] = useState(
    `${process.env.NEXT_PUBLIC_API_URL || 'http://localhost:4000'}/api/rest/v1`,
  );
  // The service key comes from the connection endpoint (the project record no
  // longer carries it) and stays masked until the user asks to see it.
  const [serviceKey, setServiceKey] = useState('');
  const [showServiceKey, setShowServiceKey] = useState(false);

  const fetchStatus = useCallback(async () => {
    if (!project) return;
    try {
      const [s, d] = await Promise.all([
        api.embeddings.getStatus(project.id),
        api.embeddings.disclosure(project.id).catch(() => null),
      ]);
      setStatus(s);
      setDisclosure(d);
    } catch (err: any) {
      toast.error(err.message || 'Failed to load embedding status');
    } finally {
      setLoading(false);
    }
  }, [project]);

  useEffect(() => {
    fetchStatus();
  }, [fetchStatus]);

  useEffect(() => {
    if (!project) return;
    api.embeddings
      .providers(project.id)
      .then(setCatalogue)
      .catch(() => undefined); // the provider card says so when the list is missing
  }, [project]);

  useEffect(() => {
    if (!project) return;
    api.projects
      .connect(project.id)
      .then((conn) => {
        if (conn?.restUrl) setRestUrl(conn.restUrl);
        if (conn?.serviceKey) setServiceKey(conn.serviceKey);
      })
      .catch(() => undefined); // keep the fallback; the status card reports real errors
  }, [project]);

  // Seed the provider form once from the saved configuration.
  useEffect(() => {
    if (!status || formSeeded) return;
    if (status.configSource === 'project') {
      setProviderSel(status.provider);
      setModel(status.model);
      setBaseUrl(status.baseUrl ?? '');
    } else {
      setProviderSel(PLATFORM_DEFAULT);
      setModel('');
      setBaseUrl('');
    }
    setFormSeeded(true);
  }, [status, formSeeded]);

  // Follow a running re-embed.
  const reembedActive =
    status?.reembed?.status === 'QUEUED' || status?.reembed?.status === 'RUNNING';
  useEffect(() => {
    if (!reembedActive) return;
    const timer = setInterval(fetchStatus, REEMBED_POLL_MS);
    return () => clearInterval(timer);
  }, [reembedActive, fetchStatus]);

  const selectedOption = useMemo(
    () =>
      catalogue?.providers.find(
        (p) =>
          p.id ===
          (providerSel === PLATFORM_DEFAULT ? catalogue?.platformProvider ?? status?.provider : providerSel),
      ) ?? null,
    [catalogue, providerSel, status?.provider],
  );

  const handleToggle = async (enabled: boolean) => {
    if (!project) return;
    if (!enabled) {
      // Turning it off is never a single click: the dialog says what happens
      // to the stored embeddings and lets the user choose.
      setDropData(false);
      setDisableOpen(true);
      return;
    }
    setToggling(true);
    try {
      await api.embeddings.enable(project.id);
      toast.success('pgvector enabled on your project database');
      await fetchStatus();
    } catch (err: any) {
      toast.error(err.message || 'Failed to enable pgvector');
    } finally {
      setToggling(false);
    }
  };

  const handleConfirmDisable = async () => {
    if (!project) return;
    setDisableOpen(false);
    setToggling(true);
    try {
      const res = await api.embeddings.disable(project.id, { dropData });
      if (dropData && !res.dataDropped) {
        toast.warning('pgvector disabled, but the server did not confirm that the embedding data was deleted.');
      } else {
        toast.success(dropData ? 'pgvector disabled and the embedding data deleted' : 'pgvector disabled; your embeddings are kept');
      }
      await fetchStatus();
    } catch (err: any) {
      toast.error(err.message || 'Failed to disable pgvector');
    } finally {
      setToggling(false);
    }
  };

  const handleSaveApiKey = async () => {
    if (!project) return;
    const key = apiKey.trim() || null;
    // The key is tested against the provider picked in the form, so a key for
    // a provider the project is about to switch to can be saved first.
    const savedSel = status?.configSource === 'project' ? status.provider : PLATFORM_DEFAULT;
    const opts =
      key && providerSel !== savedSel
        ? providerSel === PLATFORM_DEFAULT
          ? { provider: null }
          : { provider: providerSel, model: model.trim() || null, baseUrl: baseUrl.trim() || null }
        : {};
    setSavingKey(true);
    try {
      let res;
      try {
        res = await api.embeddings.setApiKey(project.id, key, opts);
      } catch (err: any) {
        if (!SKIPPABLE_KEY_ERRORS.has(err?.code)) throw err;
        const ok = await confirmDialog({
          title: 'Save the key without verifying it?',
          description: `${err.message} The key will be stored as entered; embedding requests fail until it works.`,
          confirmText: 'Save without verifying',
        });
        if (!ok) return;
        res = await api.embeddings.setApiKey(project.id, key, { ...opts, skipValidation: true });
      }
      if (!key) toast.success('API key cleared');
      else if (res?.warning) toast.warning(`API key saved. ${res.warning}`);
      else if (res?.verified) toast.success('API key verified and saved');
      else toast.success('API key saved without verification');
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

  const applyProvider = async (body: SetEmbeddingProviderBody) => {
    if (!project) return;
    const res = await api.embeddings.setProvider(project.id, body);
    toast.success(
      res.reembed.queued
        ? `Provider set to ${res.model}; re-embedding ${res.reembed.total.toLocaleString()} vectors`
        : `Provider set to ${res.model}`,
    );
    setFormSeeded(false);
    await fetchStatus();
  };

  const handleSaveProvider = async () => {
    if (!project) return;
    const body: SetEmbeddingProviderBody =
      providerSel === PLATFORM_DEFAULT
        ? { provider: null }
        : { provider: providerSel, model: model.trim() || null, baseUrl: baseUrl.trim() || null };
    setSavingProvider(true);
    try {
      await applyProvider(body);
    } catch (err: any) {
      if (err?.code === 'EMBEDDING_MODEL_CHANGE_REQUIRES_REEMBED') {
        const ok = await confirmDialog({
          title: 'Re-embed existing vectors?',
          description: err.message,
          confirmText: 'Switch and re-embed',
          destructive: true,
        });
        if (ok) {
          try {
            await applyProvider({ ...body, reembed: true });
          } catch (retryErr: any) {
            toast.error(retryErr.message || 'Failed to switch provider');
          }
        }
      } else {
        toast.error(err.message || 'Failed to switch provider');
      }
    } finally {
      setSavingProvider(false);
    }
  };

  const handleReembed = async () => {
    if (!project) return;
    setReembedding(true);
    try {
      const res = await api.embeddings.reembed(project.id);
      toast.success(
        res.queued ? `Re-embedding ${res.total.toLocaleString()} vectors` : 'Nothing to re-embed',
      );
      await fetchStatus();
    } catch (err: any) {
      toast.error(err.message || 'Failed to start the re-embed');
    } finally {
      setReembedding(false);
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

  const restPath = restUrl.replace(/^https?:\/\/[^/]+/, '');
  const providerName = status?.providerName ?? 'OpenAI';
  const modelName = status?.model ?? 'text-embedding-3-small';
  const dims = disclosure?.provider.dimensions ?? status?.dimensions ?? null;
  const storedDims = disclosure?.provider.storedDimensions ?? status?.storedDimensions ?? null;
  const reembed = status?.reembed ?? null;
  const keyRequired = selectedOption ? selectedOption.requiresApiKey : status?.requiresApiKey ?? true;
  // The key card follows the provider picked in the form, not only the saved one.
  const keyProviderId = selectedOption?.id ?? status?.provider ?? 'openai';
  const keyProviderName = selectedOption?.name ?? providerName;
  const keyHint = KEY_HINTS[keyProviderId] ?? { placeholder: 'API key', help: '' };
  const savedSel = status?.configSource === 'project' ? status.provider : PLATFORM_DEFAULT;
  const keyForUnsavedProvider = providerSel !== savedSel;
  const embeddingCount = status?.embeddingCount ?? null;

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
                {plural(status.embeddingCount, 'embedding')}
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

      <Dialog open={disableOpen} onOpenChange={setDisableOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Disable pgvector?</DialogTitle>
            <DialogDescription>
              The Embeddings API stops accepting store and search requests for this project.
              {embeddingCount != null
                ? ` The project holds ${plural(embeddingCount, 'embedding')}.`
                : ''}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2" role="radiogroup" aria-label="What happens to the stored embeddings">
            <label className="flex cursor-pointer items-start gap-3 rounded-lg border p-3 text-sm has-[:checked]:border-primary">
              <input
                type="radio"
                name="pgvector-disable"
                className="mt-1"
                checked={!dropData}
                onChange={() => setDropData(false)}
              />
              <span>
                <span className="font-medium">Keep the embedding data</span>
                <span className="block text-xs text-muted-foreground">
                  The kb_embeddings tables stay in your database and are used again when you re-enable pgvector.
                </span>
              </span>
            </label>
            <label className="flex cursor-pointer items-start gap-3 rounded-lg border p-3 text-sm has-[:checked]:border-destructive">
              <input
                type="radio"
                name="pgvector-disable"
                className="mt-1"
                checked={dropData}
                onChange={() => setDropData(true)}
              />
              <span>
                <span className="font-medium">Delete the embedding data</span>
                <span className="block text-xs text-muted-foreground">
                  Drops the kb_embeddings and kb_embeddings_store tables with every stored text and vector. This cannot
                  be undone. The vector extension stays installed for your own tables.
                </span>
              </span>
            </label>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDisableOpen(false)}>
              Cancel
            </Button>
            <Button variant="destructive" onClick={handleConfirmDisable}>
              {dropData ? 'Disable and delete data' : 'Disable pgvector'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Re-embed progress */}
      {reembed && reembed.status !== 'COMPLETED' && (
        <div
          className={`rounded-xl border p-4 ${
            reembed.status === 'FAILED' ? 'border-destructive/40 bg-destructive/5' : 'bg-card'
          }`}
        >
          <div className="flex items-center justify-between gap-4">
            <div className="flex items-center gap-2 text-sm">
              {reembed.status === 'FAILED' ? (
                <RefreshCw className="h-4 w-4 text-destructive" />
              ) : (
                <Loader2 className="h-4 w-4 animate-spin" />
              )}
              <span>
                {reembed.status === 'FAILED'
                  ? `Re-embed failed after ${reembed.done.toLocaleString()} of ${reembed.total.toLocaleString()} vectors`
                  : reembed.status === 'QUEUED'
                    ? `Re-embed queued (${reembed.total.toLocaleString()} vectors)`
                    : `Re-embedding ${reembed.done.toLocaleString()} / ${reembed.total.toLocaleString()} vectors with ${reembed.model}`}
              </span>
            </div>
            {reembed.status === 'FAILED' && (
              <Button size="sm" variant="outline" onClick={handleReembed} disabled={reembedding}>
                {reembedding ? <Loader2 className="h-4 w-4 animate-spin" /> : 'Retry'}
              </Button>
            )}
          </div>
          {reembed.status === 'FAILED' && reembed.error && (
            <p className="mt-2 text-xs text-muted-foreground">{reembed.error}</p>
          )}
          {reembed.status !== 'FAILED' && reembed.total > 0 && (
            <div className="mt-3 h-1.5 w-full overflow-hidden rounded bg-muted">
              <div
                className="h-full bg-primary transition-all"
                style={{ width: `${Math.min(100, Math.round((reembed.done / reembed.total) * 100))}%` }}
              />
            </div>
          )}
          {reembed.status !== 'FAILED' && (
            <p className="mt-2 text-xs text-muted-foreground">
              Search relevance is reduced until every vector is rewritten with the new model.
            </p>
          )}
        </div>
      )}

      {/* Card 2: Embedding provider */}
      <div className="rounded-xl border bg-card p-6">
        <div className="flex items-start gap-3">
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-violet-500/10">
            <Server className="h-5 w-5 text-violet-600 dark:text-violet-400" />
          </div>
          <div className="flex-1">
            <h2 className="text-base font-semibold">Embedding provider</h2>
            <p className="mt-0.5 text-sm text-muted-foreground">
              Which service turns your text into vectors. Leave it on the platform default, or pick a provider
              and model for this project.
            </p>
          </div>
          {status && (
            <Badge variant="outline" className="shrink-0">
              {status.configSource === 'project' ? 'Project override' : 'Platform default'}
            </Badge>
          )}
        </div>

        <div className="mt-4 grid gap-4 sm:grid-cols-2">
          <div className="space-y-2">
            <Label htmlFor="embedding-provider">Provider</Label>
            <Select value={providerSel} onValueChange={setProviderSel}>
              <SelectTrigger id="embedding-provider">
                <SelectValue placeholder="Select a provider" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={PLATFORM_DEFAULT}>
                  Platform default
                  {catalogue ? ` (${catalogue.providers.find((p) => p.id === catalogue.platformProvider)?.name ?? catalogue.platformProvider} · ${catalogue.platformModel})` : ''}
                </SelectItem>
                {(catalogue?.providers ?? []).map((p) => (
                  <SelectItem key={p.id} value={p.id}>
                    {p.name}
                    {p.selfHosted ? '' : ` · ${p.dataRegion.label}`}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-2">
            <Label htmlFor="embedding-model">Model</Label>
            <Input
              id="embedding-model"
              value={model}
              disabled={providerSel === PLATFORM_DEFAULT}
              placeholder={
                providerSel === PLATFORM_DEFAULT
                  ? catalogue?.platformModel ?? 'platform model'
                  : `${selectedOption?.defaultModel ?? ''} (default)`
              }
              onChange={(e) => setModel(e.target.value)}
            />
          </div>
          {providerSel !== PLATFORM_DEFAULT && selectedOption?.supportsBaseUrl && (
            <div className="space-y-2 sm:col-span-2">
              <Label htmlFor="embedding-base-url">Endpoint (optional)</Label>
              <Input
                id="embedding-base-url"
                value={baseUrl}
                placeholder={
                  selectedOption.selfHosted
                    ? 'https://ollama.example.com — leave empty for the platform host'
                    : 'https://… an OpenAI-compatible gateway; leave empty for the provider'
                }
                onChange={(e) => setBaseUrl(e.target.value)}
              />
              <p className="text-xs text-muted-foreground">
                Public https hosts only
                {catalogue?.allowPrivateBaseUrl ? ' (private hosts are allowed on this server)' : ''}.
              </p>
            </div>
          )}
        </div>

        <div className="mt-4 flex flex-wrap items-center gap-3">
          <Button onClick={handleSaveProvider} disabled={savingProvider || !catalogue}>
            {savingProvider ? <Loader2 className="h-4 w-4 animate-spin" /> : 'Save provider'}
          </Button>
          {selectedOption && providerSel !== PLATFORM_DEFAULT && (
            <span className="text-xs text-muted-foreground">
              {selectedOption.requiresApiKey
                ? selectedOption.platformKeyAvailable
                  ? `Uses the platform ${selectedOption.name} key unless you set a project key below.`
                  : `Needs a ${selectedOption.name} API key — add one below.`
                : 'No API key needed.'}
            </span>
          )}
          {!catalogue && (
            <span className="text-xs text-muted-foreground">Provider list unavailable.</span>
          )}
        </div>
        <p className="mt-3 text-xs text-muted-foreground">
          Claude is not listed because Anthropic does not offer an embeddings API. You can choose Claude as the model of
          the AI assistant below.
        </p>
        {status?.pgvectorEnabled && (status.embeddingCount ?? 0) > 0 && (
          <p className="mt-3 text-xs text-muted-foreground">
            Changing the model re-embeds the {status.embeddingCount?.toLocaleString()} vectors this project
            already holds; you will be asked to confirm.
          </p>
        )}
      </div>

      {/* Card 3: Provider API key */}
      <div className="rounded-xl border bg-card p-6">
        <div className="flex items-start gap-3">
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-amber-500/10">
            <Key className="h-5 w-5 text-amber-600 dark:text-amber-400" />
          </div>
          <div className="flex-1">
            <h2 className="text-base font-semibold">{keyProviderName} API key</h2>
            <p className="mt-0.5 text-sm text-muted-foreground">
              {keyRequired
                ? `Per-project ${keyProviderName} key for generating embeddings. If not set, the platform-level key is used.`
                : 'Optional for a self-hosted provider — only needed when the host sits behind an authenticating proxy.'}
            </p>
          </div>
          {status?.hasApiKey && !keyForUnsavedProvider && (
            <Badge variant="outline" className="shrink-0 gap-1.5">
              <Check className="h-3 w-3 text-emerald-500" />
              {status.keySource === 'project'
                ? 'Project key'
                : status.keySource === 'platform'
                  ? 'Platform key'
                  : 'No key needed'}
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
                placeholder={keyHint.placeholder}
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
          {keyHint.help && <p className="text-xs text-muted-foreground">{keyHint.help}</p>}
          <p className="text-xs text-muted-foreground">
            The key is checked with one small test request to {keyProviderName} before it is saved. Leave the field
            empty and click Save to clear the per-project key and fall back to the platform key.
          </p>
          {keyForUnsavedProvider && (
            <p className="text-xs text-amber-600 dark:text-amber-400">
              {keyProviderName} is selected above but not saved yet: the key is checked against {keyProviderName}.
              Click Save provider afterwards to switch.
            </p>
          )}
        </div>
      </div>

      {/* The assistant's own model and key (OpenAI, Gemini or Claude) */}
      <AiModelSettings projectId={project.id} />

      {/* Card 4: Where your data goes */}
      <div className="rounded-xl border bg-card p-6">
        <div className="flex items-start gap-3">
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-emerald-500/10">
            <Globe className="h-5 w-5 text-emerald-600 dark:text-emerald-400" />
          </div>
          <div className="flex-1">
            <h2 className="text-base font-semibold">Where your data goes</h2>
            <p className="mt-0.5 text-sm text-muted-foreground">
              The text you store or search is sent to the provider below to be turned into vectors. The vectors
              stay in your project database.
            </p>
          </div>
          {disclosure?.provider.selfHosted && (
            <Badge variant="outline" className="shrink-0">Self-hosted</Badge>
          )}
        </div>

        {disclosure ? (
          <dl className="mt-4 grid gap-x-6 gap-y-3 text-sm sm:grid-cols-2">
            <div>
              <dt className="text-xs text-muted-foreground">Provider</dt>
              <dd>
                {disclosure.provider.name}
                <span className="text-muted-foreground"> · {disclosure.provider.endpointHost}</span>
              </dd>
            </div>
            <div>
              <dt className="text-xs text-muted-foreground">Model</dt>
              <dd>
                <code className="rounded bg-muted px-1">{disclosure.provider.model}</code>
              </dd>
            </div>
            <div>
              <dt className="text-xs text-muted-foreground">Vector dimensions</dt>
              <dd>
                {disclosure.provider.dimensions != null
                  ? `${disclosure.provider.dimensions}${
                      disclosure.provider.padded && disclosure.provider.storedDimensions
                        ? ` (stored padded to ${disclosure.provider.storedDimensions})`
                        : ''
                    }`
                  : disclosure.provider.storedDimensions
                    ? `store holds ${disclosure.provider.storedDimensions}`
                    : 'not determined'}
              </dd>
            </div>
            <div>
              <dt className="text-xs text-muted-foreground">Data region</dt>
              <dd>
                {disclosure.dataRegion.label}
                {disclosure.dataRegion.code &&
                  !disclosure.dataRegion.label.toUpperCase().includes(disclosure.dataRegion.code.toUpperCase()) && (
                  <span className="text-muted-foreground"> ({disclosure.dataRegion.code})</span>
                )}
              </dd>
            </div>
            <div className="sm:col-span-2">
              <dt className="text-xs text-muted-foreground">Retention at the provider</dt>
              <dd>
                {disclosure.processing.retention}
                {disclosure.processing.policyUrl && (
                  <>
                    {' '}
                    <a
                      href={disclosure.processing.policyUrl}
                      target="_blank"
                      rel="noreferrer"
                      className="underline underline-offset-2"
                    >
                      Data-usage policy
                    </a>
                  </>
                )}
              </dd>
            </div>
            <div className="sm:col-span-2">
              <dt className="text-xs text-muted-foreground">Vector storage</dt>
              <dd>
                {disclosure.storage.engine}
                <span className="text-muted-foreground"> · region {disclosure.storage.region.label}</span>
              </dd>
            </div>
            {disclosure.fallback && (
              <div className="sm:col-span-2">
                <dt className="text-xs text-muted-foreground">Failover</dt>
                <dd>
                  {disclosure.fallback.name} · {disclosure.fallback.model} · {disclosure.fallback.dataRegion.label}
                  {disclosure.fallback.vectorSpaceDiffers && (
                    <span className="text-muted-foreground">
                      {' '}
                      — a different vector space; relevance drops while the fallback is in use
                    </span>
                  )}
                </dd>
              </div>
            )}
            {disclosure.status !== 'ok' && disclosure.statusMessage && (
              <div className="sm:col-span-2 text-destructive">{disclosure.statusMessage}</div>
            )}
          </dl>
        ) : (
          <p className="mt-4 text-sm text-muted-foreground">Disclosure unavailable.</p>
        )}
      </div>

      {/* Card 5: API Usage Guide */}
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
                  { method: 'POST', path: `${restPath}/embeddings`, desc: 'Store an embedding' },
                  { method: 'POST', path: `${restPath}/embeddings/batch`, desc: 'Store multiple embeddings' },
                  { method: 'POST', path: `${restPath}/embeddings/search`, desc: 'Semantic search' },
                  { method: 'DELETE', path: `${restPath}/embeddings`, desc: 'Delete by IDs' },
                  { method: 'GET', path: `${restPath}/embeddings/status`, desc: 'Check status' },
                  { method: 'GET', path: `${restPath}/embeddings/disclosure`, desc: 'Provider, model and data region' },
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
                  <code className="flex-1 truncate rounded bg-muted px-2 py-1 text-xs">
                    {showServiceKey ? serviceKey : serviceKey ? `••••••••${serviceKey.slice(-4)}` : '…'}
                  </code>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-7 w-7 shrink-0"
                    onClick={() => setShowServiceKey((v) => !v)}
                    disabled={!serviceKey}
                    title={showServiceKey ? 'Hide service key' : 'Show service key'}
                  >
                    {showServiceKey ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-7 w-7 shrink-0"
                    onClick={() => copyToClipboard(serviceKey, 'Service key')}
                    disabled={!serviceKey}
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
const res = await fetch('${restUrl}/embeddings', {
  method: 'POST',
  headers: {
    'apikey': process.env.BASEFYIO_SERVICE_ROLE_KEY, // server-side only
    'Content-Type': 'application/json',
  },
  body: JSON.stringify({
    content: 'How to reset my password?',
    namespace: 'faq',
    metadata: { category: 'auth' },
  }),
});

// Search similar content
const results = await fetch('${restUrl}/embeddings/search', {
  method: 'POST',
  headers: {
    'apikey': '${project.anonKey.slice(0, 20)}...',
    'Content-Type': 'application/json',
  },
  body: JSON.stringify({
    query: 'forgot my password',
    namespace: 'faq',
    limit: 5,
    threshold: 0.7, // max cosine distance (0-2, lower = stricter): keeps results with score = 1 - distance above 0.3; default 0.5
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
const res = await fetch('${restUrl}/embeddings', {
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
const results = await fetch('${restUrl}/embeddings/search', {
  method: 'POST',
  headers: {
    'apikey': '<YOUR_ANON_KEY>',
    'Content-Type': 'application/json',
  },
  body: JSON.stringify({
    query: 'forgot my password',
    namespace: 'faq',
    limit: 5,
    threshold: 0.7, // max cosine distance (0-2, lower = stricter): keeps results with score = 1 - distance above 0.3; default 0.5
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
                  <span>
                    Text is converted to a {dims != null ? `${dims}-dimensional` : ''} vector using {providerName}
                    's <code className="rounded bg-background px-1">{modelName}</code> model
                    {dims != null && storedDims != null && dims < storedDims
                      ? `, stored zero-padded to ${storedDims} dimensions`
                      : ''}
                  </span>
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
