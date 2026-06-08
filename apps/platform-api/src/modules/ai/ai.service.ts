import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import OpenAI from 'openai';
import { PrismaService } from '../../prisma/prisma.service';
import { RagService } from './rag.service';

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

  constructor(
    private readonly config: ConfigService,
    private readonly prisma: PrismaService,
    private readonly ragService: RagService,
  ) {
    const apiKey = config.get<string>('openai.apiKey');
    if (apiKey) {
      this.openai = new OpenAI({ apiKey });
    } else {
      this.logger.warn('OPENAI_API_KEY not set — AI features disabled');
    }
  }

  async chat(
    userId: string,
    message: string,
    history: ChatMessage[],
    context: AiContext,
  ) {
    if (!this.openai) {
      return {
        reply:
          'The AI assistant is unavailable. Set the OPENAI_API_KEY environment variable to enable it.',
      };
    }

    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { activeTeamId: true },
    });
    const activeTeamId = user?.activeTeamId || null;
    const teamProjects = activeTeamId
      ? await this.prisma.project.findMany({
          where: { teamId: activeTeamId, status: { not: 'DELETED' } },
          select: { id: true, name: true },
          orderBy: { createdAt: 'desc' },
          take: 300,
        })
      : [];

    if (!this.isBasefyioScopedMessage(message, teamProjects.map((p) => p.name))) {
      return {
        reply:
          'I only answer Basefyio questions for your active team projects. Ask about your project, SQL, auth, storage, backup/export, billing, team, or management.',
      };
    }

    const safeContext: AiContext = {
      ...context,
      allProjects: teamProjects,
    };
    if (
      safeContext.projectId &&
      !teamProjects.some((p) => p.id === safeContext.projectId)
    ) {
      delete safeContext.projectId;
      delete safeContext.projectName;
      delete safeContext.tables;
    }

    // Retrieve relevant context via RAG (graceful degradation — never throws)
    let ragContext = '';
    try {
      ragContext = await this.ragService.retrieveContext(message, safeContext);
    } catch (err: any) {
      this.logger.warn('RAG retrieval failed, continuing without context', err?.message);
    }

    const systemPrompt = this.buildSystemPrompt(safeContext) + ragContext;

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

  private isBasefyioScopedMessage(
    message: string,
    allowedProjectNames: string[],
  ): boolean {
    const m = message.toLowerCase();
    if (allowedProjectNames.some((name) => m.includes(name.toLowerCase()))) {
      return true;
    }
    const kbKeywords = [
      'basefyio',
      'project',
      'team',
      'dashboard',
      'sql',
      'table',
      'query',
      'postgres',
      'database',
      'auth',
      'keycloak',
      'storage',
      'bucket',
      'backup',
      'export',
      'import',
      'billing',
      'plan',
      'management',
      'feedback',
      'audit',
      'trace',
      'alert',
      'rls',
      'policy',
      'migration',
    ];
    return kbKeywords.some((k) => m.includes(k));
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

    let prompt = `You are the Basefyio AI assistant. Basefyio is a hosted PostgreSQL Backend-as-a-Service (BaaS). Users manage PostgreSQL databases, run SQL, and organize projects.

Active mode: ${mode.toUpperCase()}
${modeInstructions[mode]}

Language (critical):
- Always reply in the same natural language as the user's latest message (Turkish, English, German, etc.). Match tone and formality when reasonable.
- If the user's language is ambiguous, default to English.

General rules:
- Always wrap SQL in \`\`\`sql fenced blocks.
- Avoid suggesting destructive commands (e.g. DROP DATABASE, DROP ROLE) unless the user explicitly asks for danger-aware guidance.
- Never say you cannot access or inspect the database — instead output concrete SQL the user can run in the platform.
- When a table list is provided, tailor SQL to those tables, not generic examples.
- You are strictly limited to Basefyio and the user's active team projects only. Refuse out-of-scope topics in one sentence.`;

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
