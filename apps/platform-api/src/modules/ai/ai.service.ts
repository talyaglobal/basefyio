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
          'The AI assistant is unavailable. Set the OPENAI_API_KEY environment variable to enable it.',
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
      return { reply: `Error: ${err.message}` };
    }
  }

  private buildSystemPrompt(context: AiContext): string {
    const mode = context.mode ?? 'ask';

    const modeInstructions: Record<AiMode, string> = {
      ask: `Answer the user's question briefly, directly, and clearly.
- Focus on one topic. Avoid unnecessary filler.
- If SQL is needed, provide a single query.
- Prefer short paragraphs over long bullet lists unless the user asks otherwise.`,

      plan: `Produce a structured, step-by-step plan for the user's request.
- Number each step clearly.
- For schema design, migrations, or project structure, be specific.
- Include SQL schema changes in fenced \`\`\`sql blocks where relevant.
- Call out alternatives and trade-offs.
- End with a short "Next steps" section.`,

      agent: `You are in autonomous analysis mode. Produce every step needed to fulfill the user's request.
- Follow Analyze → Diagnose → Act.
- Emit multiple SQL queries when useful; each in its own \`\`\`sql block with a one-line explanation above it.
- Write queries that can scan the project's tables when appropriate.
- Give concrete findings, metrics, and specific recommendations (e.g. "this index may cut latency by ~40%").
- Never say you need more information — deliver maximum value from the context you have.
- Explain in one line what each SQL block will do.`,
    };

    let prompt = `You are the KolayBase AI assistant. KolayBase is a Supabase-like Backend-as-a-Service (BaaS). Users manage PostgreSQL databases, run SQL, and organize projects.

Active mode: ${mode.toUpperCase()}
${modeInstructions[mode]}

Language (critical):
- Always reply in the same natural language as the user's latest message (Turkish, English, German, etc.). Match tone and formality when reasonable.
- If the user's language is ambiguous, default to English.

General rules:
- Always wrap SQL in \`\`\`sql fenced blocks.
- Avoid suggesting destructive commands (e.g. DROP DATABASE, DROP ROLE) unless the user explicitly asks for danger-aware guidance.
- Never say you cannot access or inspect the database — instead output concrete SQL the user can run in the platform.
- When a table list is provided, tailor SQL to those tables, not generic examples.`;

    if (context.projectName) {
      prompt += `\n\nActive project: "${context.projectName}"`;
    }

    if (context.tables && context.tables.length > 0) {
      prompt += `\nKnown tables: ${context.tables.join(', ')}`;
    }

    const pageMap: Record<string, string> = {
      dashboard: 'Main dashboard',
      projects: 'Projects list',
      'project-detail': 'Project overview',
      sql: 'SQL editor',
      tables: 'Table editor',
      auth: 'Auth settings',
      storage: 'Storage',
      connect: 'Connection / import',
      logs: 'Project import logs',
    };

    if (context.page) {
      prompt += `\nCurrent UI page: ${pageMap[context.page] ?? context.page}`;
    }

    if (context.allProjects && context.allProjects.length > 0) {
      prompt += `\n\nProjects in this team: ${context.allProjects.map((p) => p.name).join(', ')}`;
      prompt += `\nWhen the user asks about a project by name, produce SQL suited to analyzing that project's data. If table names are not loaded yet, still suggest useful PostgreSQL inspection queries and note they can run them after opening the project.`;
    }

    return prompt;
  }
}
