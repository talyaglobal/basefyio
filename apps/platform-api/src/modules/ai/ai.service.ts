import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import OpenAI from 'openai';

interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
}

type AiMode = 'ask' | 'plan' | 'agent';

interface AiContext {
  projectId?: string;
  projectName?: string;
  tables?: string[];
  page?: string;
  allProjects?: { id: string; name: string }[];
  mode?: AiMode;
}

@Injectable()
export class AiService {
  private readonly logger = new Logger(AiService.name);
  private openai: OpenAI | null = null;

  constructor(private readonly config: ConfigService) {
    const apiKey = config.get<string>('openai.apiKey');
    if (apiKey) {
      this.openai = new OpenAI({ apiKey });
    } else {
      this.logger.warn('OPENAI_API_KEY not set — AI features disabled');
    }
  }

  async chat(message: string, history: ChatMessage[], context: AiContext) {
    if (!this.openai) {
      return {
        reply:
          'AI asistanı şu anda kullanılamıyor. Lütfen OPENAI_API_KEY ortam değişkenini ayarlayın.',
      };
    }

    const systemPrompt = this.buildSystemPrompt(context);

    const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [
      { role: 'system', content: systemPrompt },
      ...history.slice(-12).map((m) => ({
        role: m.role as 'user' | 'assistant',
        content: m.content,
      })),
      { role: 'user', content: message },
    ];

    try {
      const response = await this.openai.chat.completions.create({
        model: 'gpt-4o-mini',
        messages,
        max_tokens: 2048,
        temperature: 0.7,
      });

      const reply = response.choices[0].message.content ?? '';
      return { reply };
    } catch (err: any) {
      this.logger.error('OpenAI API error', err.message);
      return { reply: `Hata: ${err.message}` };
    }
  }

  private buildSystemPrompt(context: AiContext): string {
    const mode = context.mode ?? 'ask';

    const modeInstructions: Record<AiMode, string> = {
      ask: `Kullanıcının sorduğu soruyu kısa, doğrudan ve net biçimde yanıtla.
- Tek bir konuya odaklan. Gereksiz açıklama ekleme.
- SQL gerekiyorsa tek bir sorgu ver.
- Madde listesi yerine düz paragraf tercih et.`,

      plan: `Kullanıcının isteği için adım adım, yapılandırılmış bir plan oluştur.
- Her adımı numaralandır ve açıkça belirt.
- Şema tasarımı, migration adımları veya proje yapısı için ayrıntılı plan sun.
- SQL şema değişiklikleri için migration bloğu içer.
- Alternatifleri ve trade-off'ları belirt.
- Planın sonunda özet bir "Sonraki adımlar" bölümü ekle.`,

      agent: `Sen otonom analiz ve uygulama modundasın. Kullanıcının isteğini gerçekleştirmek için gerekli TÜM adımları bağımsız olarak üret.
- Analiz → Tanı → Eylem sırasını takip et.
- Birden fazla SQL sorgusu üret; her birini ayrı blokta, amacını açıklayarak sun.
- Projenin tüm tablolarını tarayacak sorgular yaz.
- Somut bulgular, metrikler ve spesifik öneri rakamları ver (örn. "Bu indeks %40 hız kazandırır").
- Hiçbir zaman "Daha fazla bilgiye ihtiyacım var" deme — elindeki bilgiyle maksimum değer üret.
- Her SQL bloğunun ne yapacağını tek satırda açıkla.`,
    };

    let prompt = `Sen KolayBase platformunun yapay zeka asistanısın. KolayBase, Supabase benzeri bir Backend-as-a-Service (BaaS) platformudur. Kullanıcılar PostgreSQL veritabanlarını yönetebilir, SQL sorguları çalıştırabilir ve projelerini organize edebilirler.

Aktif mod: ${mode.toUpperCase()}
${modeInstructions[mode]}

Genel kurallar:
- Kullanıcının kullandığı dilde cevap ver (Türkçe veya İngilizce).
- SQL sorguları yazarken her zaman \`\`\`sql kod bloğu kullan.
- Güvenli olmayan komutları (DROP DATABASE, DROP ROLE vb.) önermekten kaçın.
- ASLA "erişemiyorum" veya "inceleyemiyorum" deme — kullanıcının platformda çalıştırabileceği somut SQL üret.
- Tablo listesi sağlandıysa o tablolara özel sorgular yaz, genel örnek değil.`;

    if (context.projectName) {
      prompt += `\n\nAktif proje: "${context.projectName}"`;
    }

    if (context.tables && context.tables.length > 0) {
      prompt += `\nMevcut tablolar: ${context.tables.join(', ')}`;
    }

    const pageMap: Record<string, string> = {
      dashboard: 'Genel dashboard',
      projects: 'Projeler listesi',
      'project-detail': 'Proje detay',
      sql: 'SQL editörü',
      tables: 'Tablo editörü',
      auth: 'Auth yönetimi',
      storage: 'Storage yönetimi',
      connect: 'Bağlantı bilgileri',
    };

    if (context.page) {
      prompt += `\nKullanıcının bulunduğu sayfa: ${pageMap[context.page] ?? context.page}`;
    }

    if (context.allProjects && context.allProjects.length > 0) {
      prompt += `\n\nTakımdaki projeler: ${context.allProjects.map((p) => p.name).join(', ')}`;
      prompt += `\nKullanıcı bir projeyi sorduğunda o projenin tablolarını analiz etmek için SQL sorguları üret. Eğer tablo bilgisi henüz yoksa, "EXPLAIN tabloları görmek için projeye gitmeniz gerekiyor" demek yerine genel PostgreSQL performans sorgularını yaz ve projeye gidince çalıştırabileceğini belirt.`;
    }

    return prompt;
  }
}
