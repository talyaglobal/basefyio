'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  ArrowLeft,
  Check,
  Image as ImageIcon,
  Loader2,
  Megaphone,
  Mic,
  RefreshCw,
  Send,
  Trash2,
  Video,
} from 'lucide-react';
import { toast } from 'sonner';
import { useDashboard } from '@/app/dashboard/layout';
import { api } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { confirmDialog } from '@/components/ui/confirm-dialog';
import { cn } from '@/lib/utils';
import type {
  MarketingAgencyStatus,
  MarketingAsset,
  MarketingCampaign,
  MarketingChannel,
  MarketingPublishMode,
  MarketingVoice,
} from '@/lib/types';

const CHANNELS = ['instagram', 'x', 'linkedin', 'tiktok', 'youtube'] as const;
const LANGUAGES = [
  { code: 'en', label: 'English' },
  { code: 'tr', label: 'Turkish' },
  { code: 'de', label: 'German' },
  { code: 'es', label: 'Spanish' },
];

const STATUS_CHIP: Record<string, string> = {
  DRAFT: 'border-border bg-muted text-muted-foreground',
  GENERATING: 'border-sky-500/30 bg-sky-500/10 text-sky-600 dark:text-sky-400',
  READY: 'border-emerald-500/30 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400',
  PUBLISHING: 'border-sky-500/30 bg-sky-500/10 text-sky-600 dark:text-sky-400',
  PUBLISHED: 'border-violet-500/30 bg-violet-500/10 text-violet-600 dark:text-violet-400',
  FAILED: 'border-red-500/30 bg-red-500/10 text-red-600 dark:text-red-400',
};

function StatusChip({ status }: { status: string }) {
  return (
    <span
      className={cn(
        'rounded-full border px-2 py-0.5 text-[10px] font-medium uppercase tracking-wider',
        STATUS_CHIP[status] || STATUS_CHIP.DRAFT,
      )}
    >
      {status.toLowerCase()}
    </span>
  );
}

/** One rendered take. Clicking it makes it the version that ships. */
function AssetCard({
  asset,
  onSelect,
  busy,
}: {
  asset: MarketingAsset;
  onSelect: () => void;
  busy: boolean;
}) {
  const failed = asset.status === 'FAILED';
  return (
    <div
      className={cn(
        'overflow-hidden rounded-lg border bg-card',
        asset.selected && 'ring-2 ring-emerald-500/60',
        failed && 'border-red-500/40',
      )}
    >
      {asset.kind === 'IMAGE' && asset.url ? (
        // Provider-hosted render on an arbitrary origin — next/image would need
        // every fal.ai CDN host allow-listed, so keep it a plain img.
        // eslint-disable-next-line @next/next/no-img-element
        <img src={asset.url} alt={asset.prompt || 'Rendered image'} className="w-full" />
      ) : null}
      {asset.kind === 'VIDEO' && asset.url ? (
        <video src={asset.url} controls className="w-full" />
      ) : null}
      {asset.kind === 'AUDIO' && asset.url ? (
        <audio src={asset.url} controls className="w-full p-3" />
      ) : null}

      <div className="space-y-1.5 p-3">
        <div className="flex items-center justify-between gap-2">
          <span className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
            {asset.kind.toLowerCase()} · {asset.model || asset.provider}
          </span>
          {asset.selected ? (
            <span className="flex items-center gap-1 text-[10px] font-medium text-emerald-600 dark:text-emerald-400">
              <Check className="h-3 w-3" /> Selected
            </span>
          ) : (
            <Button variant="outline" size="sm" onClick={onSelect} disabled={busy || failed}>
              Use this
            </Button>
          )}
        </div>
        {asset.error ? <p className="text-xs text-red-600">{asset.error}</p> : null}
      </div>
    </div>
  );
}

export default function MarketingAgencyPage() {
  const { profile } = useDashboard();
  const router = useRouter();
  const isRoot = profile?.role === 'ROOT';

  const [status, setStatus] = useState<MarketingAgencyStatus | null>(null);
  const [channels, setChannels] = useState<MarketingChannel[]>([]);
  const [voices, setVoices] = useState<MarketingVoice[]>([]);
  const [campaigns, setCampaigns] = useState<MarketingCampaign[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  // New-campaign form
  const [name, setName] = useState('');
  const [brief, setBrief] = useState('');
  const [channel, setChannel] = useState<string>('instagram');
  const [language, setLanguage] = useState('en');
  const [tone, setTone] = useState('');
  const [integrationId, setIntegrationId] = useState('');

  // Per-action busy flags, so one render does not lock the whole page.
  const [busy, setBusy] = useState<string | null>(null);
  const [voiceId, setVoiceId] = useState('');
  const [postType, setPostType] = useState<'post' | 'story'>('post');

  const selected = useMemo(
    () => campaigns.find((c) => c.id === selectedId) || null,
    [campaigns, selectedId],
  );

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [statusRes, campaignRes] = await Promise.all([
        api.marketingAgency.status(),
        api.marketingAgency.listCampaigns(),
      ]);
      setStatus(statusRes);
      setCampaigns(campaignRes);
      setSelectedId((prev) => prev || campaignRes[0]?.id || null);
      setIntegrationId((prev) => prev || statusRes.defaultChannelId || '');

      // Channels and voices come from third parties that may be down; a failure
      // there should not blank the page, so fetch them separately.
      if (statusRes.publishing) {
        api.marketingAgency
          .channels()
          .then(setChannels)
          .catch(() => toast.error('Could not read the Pubbler channel list'));
      }
      if (statusRes.voice) {
        api.marketingAgency.voices().then(setVoices).catch(() => undefined);
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not load the marketing agency');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (profile && !isRoot) {
      router.replace('/dashboard');
      return;
    }
    if (isRoot) load();
  }, [profile, isRoot, load, router]);

  /** Applies a campaign an endpoint returned, keeping the list and detail in sync. */
  const applyCampaign = useCallback((campaign: MarketingCampaign) => {
    setCampaigns((prev) => {
      const idx = prev.findIndex((c) => c.id === campaign.id);
      if (idx === -1) return [campaign, ...prev];
      const next = [...prev];
      next[idx] = campaign;
      return next;
    });
    setSelectedId(campaign.id);
  }, []);

  const run = useCallback(
    async (key: string, fn: () => Promise<MarketingCampaign>, success: string) => {
      setBusy(key);
      try {
        applyCampaign(await fn());
        toast.success(success);
      } catch (err) {
        toast.error(err instanceof Error ? err.message : 'That step failed');
      } finally {
        setBusy(null);
      }
    },
    [applyCampaign],
  );

  const createCampaign = async () => {
    if (!brief.trim()) {
      toast.error('Write a brief first');
      return;
    }
    await run(
      'create',
      () =>
        api.marketingAgency.createCampaign({
          name: name.trim(),
          brief: brief.trim(),
          channel,
          language,
          tone: tone.trim() || undefined,
          integrationId: integrationId || undefined,
        }),
      'Campaign written',
    );
    setName('');
    setBrief('');
    setTone('');
  };

  const publish = async (mode: MarketingPublishMode) => {
    if (!selected) return;
    if (mode === 'now') {
      const ok = await confirmDialog({
        title: 'Publish now',
        description:
          'This posts to the connected account immediately. There is no undo from here — the post has to be removed in Pubbler or on the platform itself.',
        confirmText: 'Publish now',
        destructive: true,
      });
      if (!ok) return;
    }
    await run(
      'publish',
      () => api.marketingAgency.publish(selected.id, { mode, postType }),
      mode === 'draft' ? 'Draft created in Pubbler' : 'Published',
    );
  };

  const removeCampaign = async (campaign: MarketingCampaign) => {
    const ok = await confirmDialog({
      title: 'Delete campaign',
      description: `Delete "${campaign.name}" and everything rendered for it?`,
      confirmText: 'Delete',
      destructive: true,
    });
    if (!ok) return;
    try {
      await api.marketingAgency.deleteCampaign(campaign.id);
      setCampaigns((prev) => prev.filter((c) => c.id !== campaign.id));
      setSelectedId((prev) => (prev === campaign.id ? null : prev));
      toast.success('Campaign deleted');
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not delete the campaign');
    }
  };

  if (!profile || !isRoot) return null;

  const pipeline = [
    { label: 'Copy · Claude', ok: status?.copy, env: 'ANTHROPIC_API_KEY' },
    { label: 'Visuals · fal.ai', ok: status?.visuals, env: 'FAL_KEY' },
    { label: 'Voice · ElevenLabs', ok: status?.voice, env: 'ELEVENLABS_API_KEY' },
    { label: 'Publish · Pubbler', ok: status?.publishing, env: 'PUBBLER_API_URL' },
  ];

  return (
    <div className="mx-auto max-w-6xl space-y-5 p-6">
      <div className="flex items-center justify-between">
        <button
          onClick={() => router.push('/dashboard/admin')}
          className="flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft className="h-4 w-4" /> Admin
        </button>
        <Button variant="outline" size="sm" onClick={load} disabled={loading}>
          {loading ? (
            <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" />
          ) : (
            <RefreshCw className="mr-2 h-3.5 w-3.5" />
          )}
          Refresh
        </Button>
      </div>

      <div className="flex items-start gap-2">
        <Megaphone className="mt-0.5 h-5 w-5 text-muted-foreground" />
        <div>
          <h1 className="text-base font-semibold">Marketing Agency</h1>
          <p className="text-sm text-muted-foreground">
            A brief goes in, Claude writes the post, fal.ai renders the image and the video,
            ElevenLabs voices the script, and Pubbler distributes it. Every step is reviewed before
            the next one runs.
          </p>
        </div>
      </div>

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {pipeline.map((leg) => (
          <div key={leg.label} className="rounded-xl border bg-card px-3 py-2">
            <div className="flex items-center gap-1.5">
              <span
                className={cn('h-1.5 w-1.5 rounded-full', leg.ok ? 'bg-emerald-500' : 'bg-red-500')}
                aria-hidden
              />
              <span className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
                {leg.label}
              </span>
            </div>
            <div className="mt-0.5 text-sm font-semibold">
              {leg.ok ? 'Connected' : `Set ${leg.env}`}
            </div>
          </div>
        ))}
      </div>

      <section className="space-y-3 rounded-xl border bg-card p-4">
        <h2 className="text-base font-semibold">New campaign</h2>
        <div className="grid gap-3 sm:grid-cols-2">
          <Input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Campaign name (optional)"
            className="h-9"
          />
          <select
            value={channel}
            onChange={(e) => setChannel(e.target.value)}
            className="h-9 rounded-md border bg-background px-3 text-sm"
          >
            {CHANNELS.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
        </div>
        <textarea
          value={brief}
          onChange={(e) => setBrief(e.target.value)}
          rows={4}
          placeholder="What should this post say? e.g. Announce that Postgres branching is live, aimed at backend developers evaluating us this week."
          className="w-full rounded-md border bg-background p-3 text-sm"
        />
        <div className="grid gap-3 sm:grid-cols-3">
          <select
            value={language}
            onChange={(e) => setLanguage(e.target.value)}
            className="h-9 rounded-md border bg-background px-3 text-sm"
          >
            {LANGUAGES.map((l) => (
              <option key={l.code} value={l.code}>
                {l.label}
              </option>
            ))}
          </select>
          <Input
            value={tone}
            onChange={(e) => setTone(e.target.value)}
            placeholder="Tone (optional)"
            className="h-9"
          />
          <select
            value={integrationId}
            onChange={(e) => setIntegrationId(e.target.value)}
            className="h-9 rounded-md border bg-background px-3 text-sm"
          >
            <option value="">
              {channels.length ? 'Pick a Pubbler channel' : 'No channels loaded'}
            </option>
            {channels.map((c) => (
              <option key={c.id} value={c.id} disabled={c.disabled}>
                {c.name} ({c.identifier})
              </option>
            ))}
          </select>
        </div>
        <Button onClick={createCampaign} disabled={busy === 'create' || !status?.copy}>
          {busy === 'create' ? <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" /> : null}
          Write the campaign
        </Button>
      </section>

      <div className="grid gap-4 lg:grid-cols-[260px_1fr]">
        <section className="space-y-2">
          <h2 className="text-sm font-semibold">Campaigns</h2>
          {campaigns.length === 0 ? (
            <div className="rounded-lg border border-dashed py-10 text-center text-sm text-muted-foreground">
              Nothing yet.
            </div>
          ) : (
            <ul className="space-y-1.5">
              {campaigns.map((c) => (
                <li key={c.id}>
                  <button
                    onClick={() => setSelectedId(c.id)}
                    className={cn(
                      'w-full rounded-lg border bg-card p-2.5 text-left transition-colors hover:bg-accent',
                      c.id === selectedId && 'border-foreground/30 bg-accent',
                    )}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="truncate text-sm font-medium">{c.name}</span>
                      <StatusChip status={c.status} />
                    </div>
                    <p className="mt-0.5 truncate text-xs text-muted-foreground">
                      {c.channel} · {c.assets.length} asset{c.assets.length === 1 ? '' : 's'}
                    </p>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>

        {selected ? (
          <section className="space-y-4">
            <div className="space-y-3 rounded-xl border bg-card p-4">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <h2 className="text-base font-semibold">{selected.name}</h2>
                  <p className="text-xs text-muted-foreground">{selected.brief}</p>
                </div>
                <div className="flex items-center gap-2">
                  <StatusChip status={selected.status} />
                  <Button
                    variant="ghost"
                    size="sm"
                    className="text-red-600 hover:text-red-700"
                    onClick={() => removeCampaign(selected)}
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </Button>
                </div>
              </div>

              {selected.error ? (
                <p className="rounded-md border border-red-500/30 bg-red-500/10 p-2 text-xs text-red-600">
                  {selected.error}
                </p>
              ) : null}

              {selected.caption ? (
                <div className="space-y-2">
                  <p className="whitespace-pre-wrap text-sm">{selected.caption}</p>
                  {selected.hashtags.length ? (
                    <p className="text-xs text-muted-foreground">
                      {selected.hashtags.map((t) => `#${t}`).join(' ')}
                    </p>
                  ) : null}
                </div>
              ) : (
                <p className="text-sm text-muted-foreground">No copy yet.</p>
              )}

              <div className="flex flex-wrap gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  disabled={busy !== null || !status?.copy}
                  onClick={() =>
                    run('copy', () => api.marketingAgency.rewriteCopy(selected.id), 'Copy rewritten')
                  }
                >
                  {busy === 'copy' ? (
                    <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <RefreshCw className="mr-2 h-3.5 w-3.5" />
                  )}
                  Rewrite copy
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={busy !== null || !status?.visuals || !selected.imagePrompt}
                  onClick={() =>
                    run('image', () => api.marketingAgency.renderImage(selected.id), 'Image rendered')
                  }
                >
                  {busy === 'image' ? (
                    <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <ImageIcon className="mr-2 h-3.5 w-3.5" />
                  )}
                  Render image
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={busy !== null || !status?.visuals || !selected.videoPrompt}
                  onClick={() =>
                    run('video', () => api.marketingAgency.renderVideo(selected.id), 'Video rendered')
                  }
                >
                  {busy === 'video' ? (
                    <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <Video className="mr-2 h-3.5 w-3.5" />
                  )}
                  Render video
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={busy !== null || !status?.voice || !selected.voiceScript}
                  onClick={() =>
                    run(
                      'voice',
                      () => api.marketingAgency.renderVoiceover(selected.id, voiceId || undefined),
                      'Voiceover recorded',
                    )
                  }
                >
                  {busy === 'voice' ? (
                    <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <Mic className="mr-2 h-3.5 w-3.5" />
                  )}
                  Record voiceover
                </Button>
                {voices.length ? (
                  <select
                    value={voiceId}
                    onChange={(e) => setVoiceId(e.target.value)}
                    className="h-9 rounded-md border bg-background px-3 text-sm"
                  >
                    <option value="">Default voice</option>
                    {voices.map((v) => (
                      <option key={v.id} value={v.id}>
                        {v.name}
                      </option>
                    ))}
                  </select>
                ) : null}
              </div>
            </div>

            {selected.imagePrompt || selected.videoPrompt || selected.voiceScript ? (
              <div className="grid gap-3 rounded-xl border bg-card p-4 text-xs sm:grid-cols-3">
                <div>
                  <p className="font-medium uppercase tracking-wider text-muted-foreground">
                    Image prompt
                  </p>
                  <p className="mt-1 whitespace-pre-wrap">{selected.imagePrompt || '—'}</p>
                </div>
                <div>
                  <p className="font-medium uppercase tracking-wider text-muted-foreground">
                    Video prompt
                  </p>
                  <p className="mt-1 whitespace-pre-wrap">{selected.videoPrompt || '—'}</p>
                </div>
                <div>
                  <p className="font-medium uppercase tracking-wider text-muted-foreground">
                    Voiceover
                  </p>
                  <p className="mt-1 whitespace-pre-wrap">{selected.voiceScript || '—'}</p>
                </div>
              </div>
            ) : null}

            {selected.assets.length ? (
              <div className="grid gap-3 sm:grid-cols-2">
                {selected.assets.map((asset) => (
                  <AssetCard
                    key={asset.id}
                    asset={asset}
                    busy={busy !== null}
                    onSelect={() =>
                      run(
                        'select',
                        () => api.marketingAgency.selectAsset(selected.id, asset.id),
                        'Selection updated',
                      )
                    }
                  />
                ))}
              </div>
            ) : null}

            <div className="space-y-3 rounded-xl border bg-card p-4">
              <h3 className="text-sm font-semibold">Publish</h3>
              <p className="text-xs text-muted-foreground">
                A draft lands in Pubbler for review and is never posted on its own. Publishing now
                posts to the connected account immediately.
              </p>
              <div className="flex flex-wrap items-center gap-2">
                {selected.channel === 'instagram' ? (
                  <select
                    value={postType}
                    onChange={(e) => setPostType(e.target.value as 'post' | 'story')}
                    className="h-9 rounded-md border bg-background px-3 text-sm"
                  >
                    <option value="post">Feed post</option>
                    <option value="story">Story</option>
                  </select>
                ) : null}
                <Button
                  size="sm"
                  disabled={busy !== null || !status?.publishing || !selected.caption}
                  onClick={() => publish('draft')}
                >
                  {busy === 'publish' ? (
                    <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <Send className="mr-2 h-3.5 w-3.5" />
                  )}
                  Send draft to Pubbler
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  className="text-red-600 hover:text-red-700"
                  disabled={busy !== null || !status?.publishing || !selected.caption}
                  onClick={() => publish('now')}
                >
                  Publish now
                </Button>
              </div>
              {selected.pubblerPostId ? (
                <p className="text-xs text-muted-foreground">
                  Pubbler post {selected.pubblerPostId} · {selected.publishMode}
                </p>
              ) : null}
            </div>
          </section>
        ) : (
          <section className="rounded-xl border border-dashed py-16 text-center text-sm text-muted-foreground">
            Pick a campaign, or write a new one.
          </section>
        )}
      </div>
    </div>
  );
}
