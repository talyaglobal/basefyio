import Anthropic from '@anthropic-ai/sdk';
import { Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

/** The creative brief the agency works from. */
export interface CampaignBrief {
  /** What the post is about, in the operator's own words. */
  brief: string;
  /** Where it will be published — Claude writes to the channel's conventions. */
  channel: string;
  /** ISO-639-1 language the copy must be written in. */
  language: string;
  /** Optional brand/tone guidance, passed through verbatim. */
  tone?: string | null;
}

/** Everything Claude produces for one campaign, in one round trip. */
export interface CampaignCopy {
  caption: string;
  hashtags: string[];
  imagePrompt: string;
  videoPrompt: string;
  voiceScript: string;
}

/**
 * The schema Claude's answer is constrained to. Structured outputs mean the
 * pipeline never has to salvage JSON out of prose — a malformed response is a
 * server-side error, not a parsing puzzle here.
 */
const CAMPAIGN_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['caption', 'hashtags', 'imagePrompt', 'videoPrompt', 'voiceScript'],
  properties: {
    caption: {
      type: 'string',
      description: 'The post caption, ready to publish, without hashtags.',
    },
    hashtags: {
      type: 'array',
      items: { type: 'string' },
      description: 'Hashtags without the leading "#", most relevant first.',
    },
    imagePrompt: {
      type: 'string',
      description:
        'A text-to-image prompt describing one still frame: subject, composition, lighting, style. No text overlays.',
    },
    videoPrompt: {
      type: 'string',
      description:
        'A text-to-video prompt for a short looping clip: subject, camera movement, pacing.',
    },
    voiceScript: {
      type: 'string',
      description:
        'A spoken voiceover script of 20-40 seconds, written to be read aloud.',
    },
  },
} as const;

const SYSTEM_PROMPT = [
  'You are the copywriter for Basefy, a developer platform.',
  '',
  'For each brief you produce a complete social campaign: the caption, the hashtags,',
  'a prompt for the still image, a prompt for the short video, and the voiceover script.',
  'The image and video prompts are read by a text-to-image/video model, not by a person —',
  'describe what the frame contains, never what the post is "about".',
  '',
  'Rules that hold for every campaign:',
  '- Describe Basefy on its own terms. Never position it as an alternative, clone, or',
  '  "X-style" version of another product, and never name a competitor.',
  '- No invented metrics, customer names, testimonials, or claims that could not be',
  '  substantiated. If the brief does not supply a number, do not produce one.',
  '- Write in the requested language, in the requested tone.',
].join('\n');

/**
 * Claude writes the campaign. This is the only leg of the pipeline that decides
 * what the post says — fal.ai and ElevenLabs render prompts it has already written.
 */
@Injectable()
export class ClaudeProvider {
  private readonly logger = new Logger(ClaudeProvider.name);
  private readonly client: Anthropic | null;
  private readonly model: string;

  constructor(private readonly config: ConfigService) {
    const apiKey = config.get<string>('marketingAgency.claude.apiKey') || '';
    this.model = config.get<string>('marketingAgency.claude.model') || 'claude-opus-5';
    this.client = apiKey ? new Anthropic({ apiKey }) : null;
    if (!this.client) {
      this.logger.warn('ANTHROPIC_API_KEY not set — campaign copy generation is disabled');
    }
  }

  get configured(): boolean {
    return this.client !== null;
  }

  async writeCampaign(brief: CampaignBrief): Promise<CampaignCopy> {
    if (!this.client) {
      throw new ServiceUnavailableException(
        'Copywriting is unavailable: set ANTHROPIC_API_KEY to enable it.',
      );
    }

    const response = await this.client.messages.create({
      model: this.model,
      max_tokens: 16000,
      system: SYSTEM_PROMPT,
      thinking: { type: 'adaptive' },
      output_config: {
        effort: 'high',
        format: { type: 'json_schema', schema: CAMPAIGN_SCHEMA as Record<string, unknown> },
      },
      messages: [
        {
          role: 'user',
          content: [
            `Channel: ${brief.channel}`,
            `Language: ${brief.language}`,
            brief.tone ? `Tone: ${brief.tone}` : 'Tone: confident, plain, no hype',
            '',
            'Brief:',
            brief.brief,
          ].join('\n'),
        },
      ],
    });

    // A safety decline arrives as HTTP 200 with an empty-ish body, so check the
    // stop reason before reading content or the failure looks like bad JSON.
    if (response.stop_reason === 'refusal') {
      const category = response.stop_details?.category ?? 'unspecified';
      throw new ServiceUnavailableException(
        `Claude declined to write this campaign (${category}). Rewrite the brief and try again.`,
      );
    }

    const text = response.content
      .filter((block): block is Anthropic.TextBlock => block.type === 'text')
      .map((block) => block.text)
      .join('');

    let parsed: CampaignCopy;
    try {
      parsed = JSON.parse(text) as CampaignCopy;
    } catch {
      this.logger.error(`Claude returned unparseable copy: ${text.slice(0, 500)}`);
      throw new ServiceUnavailableException('Claude returned copy that could not be read.');
    }

    return {
      caption: parsed.caption?.trim() || '',
      // Tolerate a model that hashes its own tags despite the schema description.
      hashtags: (parsed.hashtags || []).map((tag) => tag.replace(/^#/, '').trim()).filter(Boolean),
      imagePrompt: parsed.imagePrompt?.trim() || '',
      videoPrompt: parsed.videoPrompt?.trim() || '',
      voiceScript: parsed.voiceScript?.trim() || '',
    };
  }
}
