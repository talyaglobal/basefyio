import { Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

export interface ElevenLabsVoice {
  id: string;
  name: string;
  previewUrl: string | null;
}

export interface ElevenLabsNarration {
  /** The spoken audio, as an mp3 the caller persists wherever it likes. */
  audio: Buffer;
  contentType: string;
  voiceId: string;
  model: string;
}

const API_BASE = 'https://api.elevenlabs.io';

/** ElevenLabs voices the campaign's voiceover script. */
@Injectable()
export class ElevenLabsProvider {
  private readonly logger = new Logger(ElevenLabsProvider.name);
  private readonly apiKey: string;
  private readonly defaultVoiceId: string;
  private readonly model: string;

  constructor(private readonly config: ConfigService) {
    this.apiKey = config.get<string>('marketingAgency.elevenlabs.apiKey') || '';
    this.defaultVoiceId = config.get<string>('marketingAgency.elevenlabs.voiceId') || '';
    this.model =
      config.get<string>('marketingAgency.elevenlabs.model') || 'eleven_multilingual_v2';
    if (!this.apiKey) {
      this.logger.warn('ELEVENLABS_API_KEY not set — voiceover generation is disabled');
    }
  }

  get configured(): boolean {
    return Boolean(this.apiKey);
  }

  /** The stock voices, so the dashboard offers a picker instead of a raw id field. */
  async listVoices(): Promise<ElevenLabsVoice[]> {
    if (!this.apiKey) return [];

    const res = await fetch(API_BASE + '/v2/voices?page_size=40&category=premade', {
      headers: { 'xi-api-key': this.apiKey },
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      this.logger.error('ElevenLabs voice list failed: ' + res.status + ' ' + detail.slice(0, 300));
      return [];
    }

    const payload = (await res.json()) as {
      voices?: { voice_id: string; name: string; preview_url?: string }[];
    };
    return (payload.voices || []).map((voice) => ({
      id: voice.voice_id,
      name: voice.name,
      previewUrl: voice.preview_url || null,
    }));
  }

  async narrate(text: string, voiceId?: string | null): Promise<ElevenLabsNarration> {
    if (!this.apiKey) {
      throw new ServiceUnavailableException(
        'Voiceover is unavailable: set ELEVENLABS_API_KEY to enable it.',
      );
    }

    const voice = voiceId || this.defaultVoiceId;
    if (!voice) {
      throw new ServiceUnavailableException(
        'No voice selected. Pick a voice, or set ELEVENLABS_VOICE_ID as the default.',
      );
    }

    const res = await fetch(
      API_BASE + '/v1/text-to-speech/' + encodeURIComponent(voice) + '?output_format=mp3_44100_128',
      {
        method: 'POST',
        headers: {
          'xi-api-key': this.apiKey,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ text, model_id: this.model }),
      },
    );

    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      this.logger.error('ElevenLabs narration failed: ' + res.status + ' ' + detail.slice(0, 300));
      throw new ServiceUnavailableException(
        'ElevenLabs rejected the voiceover (' + res.status + '). ' + detail.slice(0, 200),
      );
    }

    return {
      audio: Buffer.from(await res.arrayBuffer()),
      contentType: res.headers.get('content-type') || 'audio/mpeg',
      voiceId: voice,
      model: this.model,
    };
  }
}
