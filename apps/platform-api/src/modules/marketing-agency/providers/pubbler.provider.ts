import { Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

/** A connected social account as Pubbler reports it. */
export interface PubblerChannel {
  id: string;
  name: string;
  /** Provider slug: instagram, x, linkedin, ... */
  identifier: string;
  picture: string | null;
  disabled: boolean;
}

/** A media item Pubbler has taken ownership of and can attach to a post. */
export interface PubblerMedia {
  id: string;
  path: string;
}

export type PubblerPublishMode = 'draft' | 'now' | 'schedule';

export interface PubblerPostRequest {
  integrationId: string;
  content: string;
  media: PubblerMedia[];
  mode: PubblerPublishMode;
  /** Required by Pubbler for every mode; for a draft it is only a placeholder. */
  date: Date;
  /** Provider-specific settings. Ignored for drafts, required for everything else. */
  settings?: Record<string, unknown>;
}

/**
 * Pubbler is our social distribution layer. It owns the channel connections and
 * the posting schedule; this platform only hands it finished content.
 *
 * Media has to be re-hosted by Pubbler before a post can reference it — fal.ai
 * URLs are short-lived and Pubbler validates that attachments live on its own
 * storage, so every asset goes through upload-from-url first.
 */
@Injectable()
export class PubblerProvider {
  private readonly logger = new Logger(PubblerProvider.name);
  private readonly apiUrl: string;
  private readonly apiKey: string;
  private readonly defaultIntegrationId: string;

  constructor(private readonly config: ConfigService) {
    this.apiUrl = (config.get<string>('marketingAgency.pubbler.apiUrl') || '').replace(/\/+$/, '');
    this.apiKey = config.get<string>('marketingAgency.pubbler.apiKey') || '';
    this.defaultIntegrationId =
      config.get<string>('marketingAgency.pubbler.defaultIntegrationId') || '';
    if (!this.configured) {
      this.logger.warn('PUBBLER_API_URL / PUBBLER_API_KEY not set — publishing is disabled');
    }
  }

  get configured(): boolean {
    return Boolean(this.apiUrl && this.apiKey);
  }

  get defaultChannelId(): string {
    return this.defaultIntegrationId;
  }

  async listChannels(): Promise<PubblerChannel[]> {
    const list = await this.request<any[]>('/integrations');
    return (list || []).map((channel) => ({
      id: channel.id,
      name: channel.name,
      identifier: channel.identifier || channel.providerIdentifier || '',
      picture: channel.picture || null,
      disabled: Boolean(channel.disabled),
    }));
  }

  /** Hands Pubbler a remote asset URL and gets back media it will accept on a post. */
  async importMedia(url: string): Promise<PubblerMedia> {
    const media = await this.request<{ id: string; path: string }>('/upload-from-url', {
      method: 'POST',
      body: JSON.stringify({ url }),
    });
    if (!media?.id || !media?.path) {
      throw new ServiceUnavailableException('Pubbler accepted the media but returned no reference.');
    }
    return { id: media.id, path: media.path };
  }

  async createPost(req: PubblerPostRequest): Promise<{ id: string | null; raw: unknown }> {
    const post: Record<string, unknown> = {
      integration: { id: req.integrationId },
      value: [{ content: req.content, image: req.media }],
    };
    // Pubbler validates provider settings on everything except drafts, so only
    // send them when they will actually be read.
    if (req.mode !== 'draft' && req.settings) {
      post.settings = req.settings;
    }

    const created = await this.request<any>('/posts', {
      method: 'POST',
      body: JSON.stringify({
        type: req.mode,
        shortLink: false,
        date: req.date.toISOString(),
        tags: [],
        posts: [post],
      }),
    });

    // Pubbler answers with the created post(s); the shape differs between
    // versions, so pull an id out defensively rather than assuming one.
    const id =
      (Array.isArray(created) ? created[0]?.id : created?.id) ||
      created?.postId ||
      created?.group ||
      null;
    return { id: id ? String(id) : null, raw: created };
  }

  private async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    if (!this.configured) {
      throw new ServiceUnavailableException(
        'Publishing is unavailable: set PUBBLER_API_URL and PUBBLER_API_KEY to enable it.',
      );
    }

    let res: Response;
    try {
      res = await fetch(this.apiUrl + '/public/v1' + path, {
        ...init,
        headers: {
          'Content-Type': 'application/json',
          Authorization: this.apiKey,
          ...(init.headers || {}),
        },
      });
    } catch (err: any) {
      throw new ServiceUnavailableException('Pubbler could not be reached: ' + err.message);
    }

    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      this.logger.error('Pubbler ' + path + ' failed: ' + res.status + ' ' + detail.slice(0, 500));
      throw new ServiceUnavailableException(
        'Pubbler rejected the request (' + res.status + '). ' + this.summarize(detail),
      );
    }

    // upload-from-url and posts both answer with JSON; guard anyway so an empty
    // 200 does not surface as a parser stack trace.
    const text = await res.text();
    if (!text) return undefined as T;
    try {
      return JSON.parse(text) as T;
    } catch {
      throw new ServiceUnavailableException('Pubbler returned a response that could not be read.');
    }
  }

  /** Pubbler error bodies carry a msg field; fall back to the raw text. */
  private summarize(body: string): string {
    try {
      const parsed = JSON.parse(body);
      if (typeof parsed?.msg === 'string') return parsed.msg;
      if (typeof parsed?.message === 'string') return parsed.message;
      if (Array.isArray(parsed?.message)) return parsed.message.join('; ');
    } catch {
      // Not JSON — fall through to the raw body.
    }
    return body.slice(0, 200);
  }
}
