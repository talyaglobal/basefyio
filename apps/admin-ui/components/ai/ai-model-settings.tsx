'use client';

import React, { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Bot, Check, ExternalLink, Eye, EyeOff, Loader2 } from 'lucide-react';
import { api } from '@/lib/api';
import type { AiAssistantSettings } from '@/lib/ai-assistant';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { confirmDialog } from '@/components/ui/confirm-dialog';
import { cn } from '@/lib/utils';

const PLATFORM = '__platform__';

/**
 * Which model the dashboard AI assistant uses for this project.
 *
 * By default the assistant runs on basefyio's model. A project can bring its
 * own OpenAI, Google Gemini or Anthropic Claude key instead: the key is tested
 * with one tiny request before it is saved, stored encrypted, and never shown
 * again — only its last four characters are.
 */
export function AiModelSettings({ projectId, bare = false }: { projectId: string; bare?: boolean }) {
  const [settings, setSettings] = useState<AiAssistantSettings | null>(null);
  const [loading, setLoading] = useState(true);
  const [provider, setProvider] = useState<string>(PLATFORM);
  const [model, setModel] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [showKey, setShowKey] = useState(false);
  const [saving, setSaving] = useState(false);

  const apply = useCallback((s: AiAssistantSettings) => {
    setSettings(s);
    setProvider(s.provider ?? PLATFORM);
    setModel(s.model ?? '');
    setApiKey('');
  }, []);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    api.ai
      .getSettings(projectId)
      .then((s) => {
        if (!cancelled) apply(s);
      })
      .catch((err) => {
        if (!cancelled) toast.error(err?.message ?? 'Could not load the assistant settings');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [projectId, apply]);

  const info = settings?.providers.find((p) => p.id === provider) ?? null;
  const sameProvider = !!settings?.provider && settings.provider === provider;
  const keyNeeded = provider !== PLATFORM && !sameProvider;

  const save = async (skipValidation = false) => {
    if (provider === PLATFORM) {
      setSaving(true);
      try {
        apply(await api.ai.clearSettings(projectId));
        toast.success('The assistant uses the basefyio model for this project again');
      } catch (err: any) {
        toast.error(err?.message ?? 'Could not save');
      } finally {
        setSaving(false);
      }
      return;
    }
    if (keyNeeded && !apiKey.trim()) {
      toast.error(`Enter a ${info?.name ?? ''} API key`);
      return;
    }
    setSaving(true);
    try {
      const res = await api.ai.saveSettings(projectId, {
        provider,
        model: model.trim() || undefined,
        apiKey: apiKey.trim() || undefined,
        skipValidation,
      });
      apply(res.settings);
      if (res.warning) toast.warning(res.warning);
      else toast.success(skipValidation ? 'Saved without a test request' : 'Key tested and saved');
    } catch (err: any) {
      if (!skipValidation && (err?.code === 'AI_PROVIDER_UNREACHABLE' || err?.status === 502)) {
        const ok = await confirmDialog({
          title: 'Save without testing?',
          description: `${err.message} The key will be stored as entered; the assistant will report an error until it works.`,
          confirmText: 'Save without testing',
        });
        if (ok) await save(true);
        return;
      }
      toast.error(err?.message ?? 'Could not save the key');
    } finally {
      setSaving(false);
    }
  };

  const body = loading ? (
    <div className="flex items-center gap-2 text-sm text-muted-foreground">
      <Loader2 className="h-4 w-4 animate-spin" /> Loading…
    </div>
  ) : !settings ? (
    <p className="text-sm text-muted-foreground">Assistant settings are unavailable.</p>
  ) : (
    <div className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label htmlFor="ai-provider">Provider</Label>
          <Select
            value={provider}
            onValueChange={(v) => {
              setProvider(v);
              const next = settings.providers.find((p) => p.id === v);
              setModel(v === settings.provider ? settings.model ?? '' : next?.defaultModel ?? '');
              setApiKey('');
            }}
          >
            <SelectTrigger id="ai-provider">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={PLATFORM}>basefyio default ({settings.platform.model})</SelectItem>
              {settings.providers.map((p) => (
                <SelectItem key={p.id} value={p.id}>
                  {p.name} — your key
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="ai-model">Model</Label>
          <Input
            id="ai-model"
            list="ai-model-suggestions"
            value={provider === PLATFORM ? settings.platform.model : model}
            disabled={provider === PLATFORM}
            onChange={(e) => setModel(e.target.value)}
            placeholder={info?.defaultModel}
          />
          <datalist id="ai-model-suggestions">
            {info?.models.map((m) => <option key={m} value={m} />)}
          </datalist>
        </div>
      </div>

      {provider !== PLATFORM && info && (
        <div className="space-y-1.5">
          <Label htmlFor="ai-api-key">{info.name} API key</Label>
          <div className="relative">
            <Input
              id="ai-api-key"
              type={showKey ? 'text' : 'password'}
              autoComplete="off"
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              placeholder={sameProvider && settings.keyHint ? `Saved key ${settings.keyHint} — leave empty to keep it` : info.keyPlaceholder}
              className="pr-10"
            />
            <button
              type="button"
              onClick={() => setShowKey((s) => !s)}
              className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
            >
              {showKey ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
            </button>
          </div>
          <p className="text-xs text-muted-foreground">
            The key is checked with one small request to {info.name} before it is saved, stored encrypted, and used only
            for assistant conversations about this project. Usage is billed by {info.name} to your account.{' '}
            <a href={info.keyHelpUrl} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-0.5 text-primary underline-offset-2 hover:underline">
              Get a key <ExternalLink className="h-3 w-3" />
            </a>
          </p>
        </div>
      )}

      {provider === PLATFORM && !settings.platform.available && (
        <p className="text-xs text-amber-700 dark:text-amber-400">
          This installation has no platform model configured, so the assistant needs a project key to answer.
        </p>
      )}

      <div className="flex justify-end">
        <Button onClick={() => void save()} disabled={saving}>
          {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : provider === PLATFORM ? 'Use basefyio default' : 'Test and save'}
        </Button>
      </div>
    </div>
  );

  if (bare) return body;

  return (
    <div className="rounded-xl border bg-card p-6">
      <div className="flex items-start gap-3">
        <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-blue-500/10">
          <Bot className="h-5 w-5 text-blue-600 dark:text-blue-400" />
        </div>
        <div className="flex-1">
          <h2 className="text-base font-semibold">AI assistant model</h2>
          <p className="mt-0.5 text-sm text-muted-foreground">
            The model behind the dashboard assistant (Ask, Plan and Agent) for this project. Use the basefyio default, or
            your own OpenAI, Google Gemini or Anthropic Claude key.
          </p>
        </div>
        {settings && (
          <Badge variant="outline" className={cn('shrink-0 gap-1.5')}>
            <Check className="h-3 w-3 text-emerald-500" />
            {settings.provider
              ? `${settings.providers.find((p) => p.id === settings.provider)?.name ?? settings.provider} · ${settings.model}`
              : 'basefyio default'}
          </Badge>
        )}
      </div>
      <div className="mt-4">{body}</div>
    </div>
  );
}
