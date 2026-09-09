import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import {
  MarketingAssetKind,
  MarketingAssetStatus,
  MarketingCampaignStatus,
  Prisma,
} from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { StorageService } from '../storage/storage.service';
import { ClaudeProvider } from './providers/claude.provider';
import { ElevenLabsProvider } from './providers/elevenlabs.provider';
import { FalAspectRatio, FalProvider } from './providers/fal.provider';
import { PubblerProvider, PubblerPublishMode } from './providers/pubbler.provider';

export interface CreateCampaignInput {
  name: string;
  brief: string;
  channel?: string;
  language?: string;
  tone?: string;
  integrationId?: string;
}

export interface PublishCampaignInput {
  mode: PubblerPublishMode;
  /** Only meaningful for mode 'schedule'. */
  date?: string;
  /** Instagram distinguishes feed posts from stories. */
  postType?: 'post' | 'story';
}

/** The frame each channel actually shows, so renders are not cropped on arrival. */
const ASPECT_BY_CHANNEL: Record<string, FalAspectRatio> = {
  instagram: '4:5',
  tiktok: '9:16',
  youtube: '16:9',
  x: '16:9',
  linkedin: '1:1',
};

const CAMPAIGN_INCLUDE = {
  assets: { orderBy: { createdAt: 'asc' } },
} satisfies Prisma.MarketingCampaignInclude;

/**
 * The agency pipeline: a brief becomes copy (Claude), then renders (fal.ai and
 * ElevenLabs), then a post on Pubbler.
 *
 * Each stage is a separate call rather than one long chain, because a campaign is
 * reviewed between stages — the copy gets read before art is paid for, and the art
 * gets looked at before anything reaches a public account.
 */
@Injectable()
export class MarketingAgencyService {
  private readonly logger = new Logger(MarketingAgencyService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: StorageService,
    private readonly claude: ClaudeProvider,
    private readonly fal: FalProvider,
    private readonly elevenlabs: ElevenLabsProvider,
    private readonly pubbler: PubblerProvider,
  ) {}

  /** Which legs of the pipeline are wired up, so the dashboard can say so plainly. */
  status() {
    return {
      copy: this.claude.configured,
      visuals: this.fal.configured,
      voice: this.elevenlabs.configured,
      publishing: this.pubbler.configured,
      falModels: this.fal.models,
      defaultChannelId: this.pubbler.defaultChannelId || null,
    };
  }

  listCampaigns() {
    return this.prisma.marketingCampaign.findMany({
      include: CAMPAIGN_INCLUDE,
      orderBy: { createdAt: 'desc' },
      take: 100,
    });
  }

  async getCampaign(id: string) {
    const campaign = await this.prisma.marketingCampaign.findUnique({
      where: { id },
      include: CAMPAIGN_INCLUDE,
    });
    if (!campaign) throw new NotFoundException('Campaign not found');
    return campaign;
  }

  async deleteCampaign(id: string) {
    await this.getCampaign(id);
    await this.prisma.marketingCampaign.delete({ where: { id } });
    return { deleted: true };
  }

  /** Pubbler owns the channel list; the dashboard reads it through us. */
  listChannels() {
    return this.pubbler.listChannels();
  }

  listVoices() {
    return this.elevenlabs.listVoices();
  }

  /**
   * Creates the campaign and writes its copy in one step. The row is saved before
   * Claude is called, so a failed generation leaves a campaign you can retry
   * rather than losing the brief.
   */
  async createCampaign(userId: string, input: CreateCampaignInput) {
    const brief = input.brief?.trim();
    if (!brief) throw new BadRequestException('A brief is required');

    const campaign = await this.prisma.marketingCampaign.create({
      data: {
        name: input.name?.trim() || brief.slice(0, 60),
        brief,
        channel: input.channel || 'instagram',
        language: input.language || 'en',
        tone: input.tone?.trim() || null,
        integrationId: input.integrationId || this.pubbler.defaultChannelId || null,
        status: MarketingCampaignStatus.GENERATING,
        createdBy: userId,
      },
    });

    return this.writeCopy(campaign.id);
  }

  /** Re-runs the copywriter over an existing brief, keeping the campaign's assets. */
  async writeCopy(campaignId: string) {
    const campaign = await this.getCampaign(campaignId);

    await this.prisma.marketingCampaign.update({
      where: { id: campaignId },
      data: { status: MarketingCampaignStatus.GENERATING, error: null },
    });

    try {
      const copy = await this.claude.writeCampaign({
        brief: campaign.brief,
        channel: campaign.channel,
        language: campaign.language,
        tone: campaign.tone,
      });

      return await this.prisma.marketingCampaign.update({
        where: { id: campaignId },
        data: {
          caption: copy.caption,
          hashtags: copy.hashtags,
          imagePrompt: copy.imagePrompt,
          videoPrompt: copy.videoPrompt,
          voiceScript: copy.voiceScript,
          status: MarketingCampaignStatus.READY,
          error: null,
        },
        include: CAMPAIGN_INCLUDE,
      });
    } catch (err: any) {
      await this.markFailed(campaignId, err.message);
      throw err;
    }
  }

  /** Lets an operator fix the copy by hand before anything is rendered from it. */
  async updateCopy(
    campaignId: string,
    patch: {
      caption?: string;
      hashtags?: string[];
      imagePrompt?: string;
      videoPrompt?: string;
      voiceScript?: string;
    },
  ) {
    await this.getCampaign(campaignId);
    return this.prisma.marketingCampaign.update({
      where: { id: campaignId },
      data: {
        ...(patch.caption !== undefined ? { caption: patch.caption } : {}),
        ...(patch.hashtags !== undefined
          ? { hashtags: patch.hashtags.map((t) => t.replace(/^#/, '').trim()).filter(Boolean) }
          : {}),
        ...(patch.imagePrompt !== undefined ? { imagePrompt: patch.imagePrompt } : {}),
        ...(patch.videoPrompt !== undefined ? { videoPrompt: patch.videoPrompt } : {}),
        ...(patch.voiceScript !== undefined ? { voiceScript: patch.voiceScript } : {}),
      },
      include: CAMPAIGN_INCLUDE,
    });
  }

  async renderImage(campaignId: string) {
    const campaign = await this.getCampaign(campaignId);
    const prompt = campaign.imagePrompt;
    if (!prompt) {
      throw new BadRequestException('This campaign has no image prompt yet. Write the copy first.');
    }
    return this.render(campaign.id, MarketingAssetKind.IMAGE, 'fal', prompt, () =>
      this.fal.renderImage(prompt, this.aspectFor(campaign.channel)),
    );
  }

  async renderVideo(campaignId: string) {
    const campaign = await this.getCampaign(campaignId);
    const prompt = campaign.videoPrompt;
    if (!prompt) {
      throw new BadRequestException('This campaign has no video prompt yet. Write the copy first.');
    }
    return this.render(campaign.id, MarketingAssetKind.VIDEO, 'fal', prompt, () =>
      this.fal.renderVideo(prompt, this.aspectFor(campaign.channel, true)),
    );
  }

  async renderVoiceover(campaignId: string, voiceId?: string) {
    const campaign = await this.getCampaign(campaignId);
    const script = campaign.voiceScript;
    if (!script) {
      throw new BadRequestException(
        'This campaign has no voiceover script yet. Write the copy first.',
      );
    }
    return this.render(campaign.id, MarketingAssetKind.AUDIO, 'elevenlabs', script, async () => {
      const narration = await this.elevenlabs.narrate(script, voiceId);
      const stored = await this.storage.uploadMarketingAsset(
        campaign.id,
        narration.audio,
        narration.contentType,
        'mp3',
      );
      return { url: stored.url, model: narration.model };
    });
  }

  /**
   * Marks one asset as the take that ships. Selection is per kind, so a campaign
   * can carry a chosen image and a chosen voiceover at the same time.
   */
  async selectAsset(campaignId: string, assetId: string) {
    const campaign = await this.getCampaign(campaignId);
    const asset = campaign.assets.find((a) => a.id === assetId);
    if (!asset) throw new NotFoundException('Asset not found on this campaign');

    await this.prisma.$transaction([
      this.prisma.marketingAsset.updateMany({
        where: { campaignId, kind: asset.kind },
        data: { selected: false },
      }),
      this.prisma.marketingAsset.update({
        where: { id: assetId },
        data: { selected: true },
      }),
    ]);

    return this.getCampaign(campaignId);
  }

  /**
   * Pushes the campaign to Pubbler. Media is re-hosted by Pubbler first, because
   * fal.ai URLs expire and Pubbler will not attach media it does not own.
   */
  async publish(campaignId: string, input: PublishCampaignInput) {
    const campaign = await this.getCampaign(campaignId);

    if (!campaign.caption) {
      throw new BadRequestException('This campaign has no caption yet. Write the copy first.');
    }
    const integrationId = campaign.integrationId || this.pubbler.defaultChannelId;
    if (!integrationId) {
      throw new BadRequestException(
        'No Pubbler channel selected. Pick one, or set PUBBLER_DEFAULT_INTEGRATION_ID.',
      );
    }
    if (input.mode === 'schedule' && !input.date) {
      throw new BadRequestException('A scheduled post needs a date');
    }

    // Only visual media goes on the post — the voiceover is a production asset,
    // not something a caption-plus-image post can carry.
    const visuals = campaign.assets.filter(
      (a) =>
        a.selected &&
        a.status === MarketingAssetStatus.READY &&
        a.url &&
        (a.kind === MarketingAssetKind.IMAGE || a.kind === MarketingAssetKind.VIDEO),
    );

    await this.prisma.marketingCampaign.update({
      where: { id: campaignId },
      data: { status: MarketingCampaignStatus.PUBLISHING, error: null },
    });

    try {
      const media = [];
      for (const asset of visuals) {
        media.push(await this.pubbler.importMedia(asset.url as string));
      }

      const hashtags = campaign.hashtags.map((tag) => '#' + tag).join(' ');
      const content = hashtags ? campaign.caption + '\n\n' + hashtags : campaign.caption;

      const created = await this.pubbler.createPost({
        integrationId,
        content,
        media,
        mode: input.mode,
        date: input.date ? new Date(input.date) : new Date(),
        settings:
          campaign.channel === 'instagram'
            ? { post_type: input.postType || 'post', collaborators: [] }
            : {},
      });

      return await this.prisma.marketingCampaign.update({
        where: { id: campaignId },
        data: {
          integrationId,
          pubblerPostId: created.id,
          publishMode: input.mode,
          // A draft is not published — it is waiting for a human in Pubbler.
          publishedAt: input.mode === 'now' ? new Date() : null,
          status:
            input.mode === 'draft'
              ? MarketingCampaignStatus.READY
              : MarketingCampaignStatus.PUBLISHED,
          error: null,
        },
        include: CAMPAIGN_INCLUDE,
      });
    } catch (err: any) {
      await this.markFailed(campaignId, err.message);
      throw err;
    }
  }

  /**
   * Runs one render, recording the attempt whether or not it succeeds — a failed
   * render stays visible in the dashboard instead of vanishing into the logs.
   */
  private async render(
    campaignId: string,
    kind: MarketingAssetKind,
    provider: string,
    prompt: string,
    run: () => Promise<{ url: string; model: string }>,
  ) {
    const asset = await this.prisma.marketingAsset.create({
      data: { campaignId, kind, provider, prompt, status: MarketingAssetStatus.PENDING },
    });

    try {
      const result = await run();
      await this.prisma.marketingAsset.update({
        where: { id: asset.id },
        data: {
          url: result.url,
          model: result.model,
          status: MarketingAssetStatus.READY,
          error: null,
        },
      });
      // First successful take of its kind wins by default; the operator can switch.
      const alreadySelected = await this.prisma.marketingAsset.count({
        where: { campaignId, kind, selected: true },
      });
      if (alreadySelected === 0) {
        await this.prisma.marketingAsset.update({
          where: { id: asset.id },
          data: { selected: true },
        });
      }
    } catch (err: any) {
      this.logger.error(`${kind} render failed for campaign ${campaignId}: ${err.message}`);
      await this.prisma.marketingAsset.update({
        where: { id: asset.id },
        data: { status: MarketingAssetStatus.FAILED, error: err.message },
      });
      throw err;
    }

    return this.getCampaign(campaignId);
  }

  private aspectFor(channel: string, vertical = false): FalAspectRatio {
    if (vertical && (channel === 'instagram' || channel === 'tiktok')) return '9:16';
    return ASPECT_BY_CHANNEL[channel] || '1:1';
  }

  private async markFailed(campaignId: string, message: string) {
    await this.prisma.marketingCampaign.update({
      where: { id: campaignId },
      data: { status: MarketingCampaignStatus.FAILED, error: message },
    });
  }
}
