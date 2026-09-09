import { Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

export interface FalRenderResult {
  url: string;
  model: string;
}

/** Aspect ratios the channels we publish to actually use. */
export type FalAspectRatio = '1:1' | '4:5' | '9:16' | '16:9';

/**
 * A rendered video can take minutes, so give the request far more room than a
 * default HTTP timeout would allow rather than failing a render that is working.
 */
const REQUEST_TIMEOUT_MS = 10 * 60 * 1000;

/**
 * fal.ai renders the prompts Claude wrote. Both image and video models are
 * reached through the same synchronous run endpoint — the response shape is
 * what tells them apart.
 */
@Injectable()
export class FalProvider {
  private readonly logger = new Logger(FalProvider.name);
  private readonly apiKey: string;
  private readonly imageModel: string;
  private readonly videoModel: string;

  constructor(private readonly config: ConfigService) {
    this.apiKey = config.get<string>('marketingAgency.fal.apiKey') || '';
    this.imageModel = config.get<string>('marketingAgency.fal.imageModel') || 'fal-ai/flux/dev';
    this.videoModel =
      config.get<string>('marketingAgency.fal.videoModel') ||
      'fal-ai/kling-video/v1/standard/text-to-video';
    if (!this.apiKey) {
      this.logger.warn('FAL_KEY not set — image and video rendering are disabled');
    }
  }

  get configured(): boolean {
    return Boolean(this.apiKey);
  }

  get models(): { image: string; video: string } {
    return { image: this.imageModel, video: this.videoModel };
  }

  async renderImage(prompt: string, aspectRatio: FalAspectRatio = '4:5'): Promise<FalRenderResult> {
    return this.run(this.imageModel, {
      prompt,
      aspect_ratio: aspectRatio,
      num_images: 1,
      output_format: 'jpeg',
    });
  }

  async renderVideo(prompt: string, aspectRatio: FalAspectRatio = '9:16'): Promise<FalRenderResult> {
    return this.run(this.videoModel, {
      prompt,
      aspect_ratio: aspectRatio,
      duration: '5',
    });
  }

  private async run(model: string, body: Record<string, unknown>): Promise<FalRenderResult> {
    if (!this.apiKey) {
      throw new ServiceUnavailableException(
        'Rendering is unavailable: set FAL_KEY to enable image and video generation.',
      );
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

    let res: Response;
    try {
      res = await fetch('https://fal.run/' + model, {
        method: 'POST',
        signal: controller.signal,
        headers: {
          Authorization: 'Key ' + this.apiKey,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
      });
    } catch (err: any) {
      if (err?.name === 'AbortError') {
        throw new ServiceUnavailableException(
          'fal.ai did not finish rendering with ' + model + ' within 10 minutes.',
        );
      }
      throw new ServiceUnavailableException('fal.ai could not be reached: ' + err.message);
    } finally {
      clearTimeout(timeout);
    }

    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      this.logger.error('fal.ai ' + model + ' failed: ' + res.status + ' ' + detail.slice(0, 500));
      throw new ServiceUnavailableException(
        'fal.ai rejected the render (' + res.status + '). ' + this.summarize(detail),
      );
    }

    const payload = (await res.json()) as {
      images?: { url?: string }[];
      video?: { url?: string };
      url?: string;
    };

    // Image models answer with images[], video models with video. A model swapped
    // in through the env var may do either, so accept both shapes.
    const url = payload.video?.url || payload.images?.[0]?.url || payload.url;
    if (!url) {
      this.logger.error('fal.ai ' + model + ' returned no asset URL');
      throw new ServiceUnavailableException('fal.ai returned no asset for ' + model + '.');
    }

    return { url, model };
  }

  /** fal.ai error bodies are JSON with a detail field; fall back to raw text. */
  private summarize(body: string): string {
    try {
      const parsed = JSON.parse(body);
      const detail = parsed?.detail;
      if (typeof detail === 'string') return detail;
      if (Array.isArray(detail)) {
        return detail.map((d: any) => d?.msg || '').filter(Boolean).join('; ');
      }
    } catch {
      // Not JSON — fall through to the raw body.
    }
    return body.slice(0, 200);
  }
}
