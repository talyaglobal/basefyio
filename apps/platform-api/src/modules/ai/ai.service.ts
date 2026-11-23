import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import OpenAI from 'openai';
import { PrismaService } from '../../prisma/prisma.service';
import { RagService } from './rag.service';
import { EntitlementService } from '../entitlement/entitlement.service';

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


const SCOPE_KEYWORDS = [
  // platform
  'basefyio', 'project', 'proje', 'team', 'takım', 'takim', 'ekip', 'dashboard', 'panel',
  'auth', 'keycloak', 'kimlik', 'kullanıcı', 'kullanici', 'user', 'login', 'giriş', 'oturum',
  'storage', 'bucket', 'depolama', 'dosya', 'file', 'backup', 'yedek', 'export', 'import',
  'dışa aktar', 'içe aktar', 'billing', 'fatura', 'ödeme', 'odeme', 'plan', 'management',
  'feedback', 'audit', 'trace', 'alert', 'uyarı', 'realtime', 'flow', 'embedding', 'vector',
  'api', 'sdk', 'webhook', 'cron',
  // data and SQL
  'sql', 'table', 'tablo', 'query', 'sorgu', 'postgres', 'database', 'veritabanı', 'veritabani',
  'veri', 'data', 'column', 'kolon', 'sütun', 'sutun', 'row', 'satır', 'satir', 'kayıt', 'kayit',
  'record', 'insert', 'ekle', 'update', 'güncelle', 'guncelle', 'delete', 'select', 'join',
  'count', 'sayı', 'index', 'indeks', 'schema', 'şema', 'sema', 'migration', 'rls', 'policy',
  'politika', 'trigger', 'function', 'fonksiyon', 'constraint', 'foreign key', 'primary key',
  'post', 'listele',
];

const ABUSE_PATTERN =
  /\b(ignore (all |any )?(previous|prior|above) (instructions|prompts?)|disregard (the )?(system|previous) (prompt|instructions)|reveal (your |the )?system prompt|jailbreak|önceki talimatları (yok say|unut)|sistem (istemini|promptunu) (göster|açıkla))\b/i;

@Injectable()
export class AiService {
  private readonly logger = new Logger(AiService.name);
  private openai: OpenAI | null = null;

  constructor(
    private readonly config: ConfigService,
    private readonly prisma: PrismaService,
    private readonly ragService: RagService,
    private readonly entitlements: EntitlementService,
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

    // Paid-model feature: Pro and above. The plan that counts is the team of
    // the project the caller has open (when they belong to it), otherwise the
    // active team.
    let billingTeamId = activeTeamId;
    if (context.projectId) {
      const openProject = await this.prisma.project.findFirst({
        where: {
          id: context.projectId,
          status: { not: 'DELETED' },
          team: { members: { some: { userId } } },
        },
        select: { teamId: true },
      });
      if (openProject) billingTeamId = openProject.teamId;
    }
    await this.entitlements.assertTeamCanUseAi(billingTeamId);
    const teamProjects = activeTeamId
      ? await this.prisma.project.findMany({
          where: { teamId: activeTeamId, status: { not: 'DELETED' } },
          select: { id: true, name: true },
          orderBy: { createdAt: 'desc' },
          take: 300,
        })
      : [];

    if (!this.isbasefyioScopedMessage(message, teamProjects.map((p) => p.name))) {
      return {
        reply:
          'I only answer basefyio questions for your active team projects. Ask about your project, SQL, auth, storage, backup/export, billing, team, or management.',
      };
    }

    const safeContext: AiContext = {
      ...context,
      allProjects: teamProjects,
    };
    // The open project counts when the caller is a member of its team, not
    // only when it sits in their *active* team: otherwise a project opened
    // from another team lost its context and the model asked to "open" it.
    const projectAllowed =
      !safeContext.projectId ||
      teamProjects.some((p) => p.id === safeContext.projectId) ||
      !!(await this.prisma.project.findFirst({
        where: {
          id: safeContext.projectId,
          status: { not: 'DELETED' },
          team: { members: { some: { userId } } },
        },
        select: { id: true },
      }));
    if (!projectAllowed) {
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

  /**
   * Cheap pre-filter in front of the model. It only rejects clearly off-topic
   * or abusive input; anything that plausibly concerns data, SQL, or the
   * platform passes (English and Turkish). The system prompt still limits the
   * model to basefyio topics.
   */
  isbasefyioScopedMessage(
    message: string,
    allowedProjectNames: string[],
  ): boolean {
    const m = message.toLocaleLowerCase('tr').normalize('NFC');
    if (allowedProjectNames.some((name) => name && m.includes(name.toLocaleLowerCase('tr')))) {
      return true;
    }
    if (ABUSE_PATTERN.test(m)) return false;
    // Identifier-looking tokens (snake_case, schema.table) mean the user names a database object.
    if (/\b[a-z][a-z0-9]*_[a-z0-9_]+\b/.test(m) || /\b[a-z_]+\.[a-z_]+\b/.test(m)) return true;
    // Keywords match at the start of a word so Turkish suffixes work (tablolar) but "capital" does not hit "api".
    return SCOPE_KEYWORDS.some((k) => new RegExp(`(^|[^\\p{L}\\p{N}])${k}`, 'u').test(m));
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

    let prompt = `You are the basefyio AI assistant. basefyio is a backend platform: every project gets a dedicated PostgreSQL database with an auto-generated REST API, and users manage projects, run SQL and organize teams from the dashboard.
When asked what basefyio can do, cover the whole platform, not only PostgreSQL: PostgreSQL databases and SQL editor, document (NoSQL) collections through the data engine, Auth (users, providers, MFA), Storage (S3-compatible buckets), Realtime (change events, presence, broadcast), Flows (trigger-and-action automation), embeddings and AI search, backups and export, integrations (GitHub, Vercel), Supabase import, billing and team roles.

Active mode: ${mode.toUpperCase()}
${modeInstructions[mode]}

Language (critical):
- Always reply in the same natural language as the user's latest message (Turkish, English, German, etc.). Match tone and formality when reasonable.
- If the user's language is ambiguous, default to English.

PostgreSQL dialect (critical, SQL is run on a real PostgreSQL database):
- Write only valid PostgreSQL. Never use MySQL syntax (no "ON UPDATE CURRENT_TIMESTAMP", AUTO_INCREMENT, backticks, INT UNSIGNED). Use "id uuid PRIMARY KEY DEFAULT gen_random_uuid()" or bigint GENERATED ALWAYS AS IDENTITY, timestamptz DEFAULT now(), and a BEFORE UPDATE trigger function when updated_at must refresh.
- Only reference tables and columns that are listed in the context or that your own SQL creates. Do not invent a "users" table: platform users live in auth, and the current user is auth.uid().
- Ownership columns are "user_id uuid" (or "owner_id uuid"), never integer.
- Row Level Security uses the platform's functions, not current_setting(): auth.uid() returns the signed-in user's id as text (compare with "user_id::text" for uuid columns), auth.role() returns the role ('anon', 'authenticated', 'service_role'), auth.jwt() returns the token claims as jsonb, auth.email() the e-mail.
- Policy shape: ALTER TABLE t ENABLE ROW LEVEL SECURITY; then one CREATE POLICY per command. SELECT and DELETE take USING, INSERT takes only WITH CHECK, UPDATE takes both. "FOR INSERT, UPDATE" is not valid: use "FOR ALL" or separate policies. Example: CREATE POLICY "own rows" ON public.notes FOR ALL TO authenticated USING (auth.uid() = user_id::text) WITH CHECK (auth.uid() = user_id::text);
- Suggest an index (CREATE INDEX ...) on foreign keys and ownership columns used in policies or filters.
- End every statement with a semicolon. If the user reports a syntax error, read the error and fix the cause; do not suggest unrelated changes.
- Use ALTER TABLE ... ENABLE ROW LEVEL SECURITY and policies only as SQL for the user to review; never claim that something has been applied.

General rules:
- Always wrap SQL in \`\`\`sql fenced blocks.
- Avoid suggesting destructive commands (e.g. DROP DATABASE, DROP ROLE) unless the user explicitly asks for danger-aware guidance.
- Never say you cannot access or inspect the database — instead output concrete SQL the user can run in the platform.
- When a table list is provided, tailor SQL to those tables, not generic examples.
- You are strictly limited to basefyio and the user's active team projects only. Refuse out-of-scope topics in one sentence.`;

    if (context.projectName) {
      prompt += `\n\nActive project: "${context.projectName}"`;
    }

    if (context.tables && context.tables.length > 0) {
      prompt += `\nKnown tables: ${context.tables.join(', ')}`;
    } else if (context.projectId) {
      prompt += `\nThe project is already open and its table list came back empty. Say so, and give a query to inspect it (information_schema.tables). Never ask the user to open the project.`;
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
      logs: 'Project logs',
    };

    if (context.page) {
      prompt += `\nCurrent UI page: ${pageMap[context.page] ?? context.page}`;
    }

    if (context.allProjects && context.allProjects.length > 0) {
      prompt += `\n\nProjects in this team: ${context.allProjects.map((p) => p.name).join(', ')}`;
      prompt += `\nWhen the user asks about a project by name, produce SQL suited to analyzing that project's data.${context.projectId ? '' : ' If table names are not loaded yet, still suggest useful PostgreSQL inspection queries and note they can run them after opening the project.'}`;
    }

    return prompt;
  }
}
