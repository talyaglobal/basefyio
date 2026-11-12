import {
  BadRequestException,
  Injectable,
  Logger,
  ServiceUnavailableException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { RagService } from './rag.service';
import { AiDatabaseService, StatementResult } from './ai-database.service';
import { AiProposalsService, AiProposalView } from './ai-proposals.service';
import { AiSettingsService, ResolvedLlm } from './ai-settings.service';
import { LlmError, LlmTurn } from './ai-llm';
import { AiMode, ProjectSchemaSnapshot, buildResultsTurn, buildSystemPrompt } from './ai-prompt';
import { SCOPE_JUDGE_PROMPT, parseScopeJudgement, quickScope } from './ai-scope';
import {
  AnalyzedStatement,
  extractSqlBlocks,
  isReadOnlyScript,
  normalizeProposal,
  splitStatements,
  analyzeStatement,
} from './ai-sql';
import { describeOutcome } from './ai-outcome';

export interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
}

export interface AiContext {
  projectId?: string;
  projectName?: string;
  /** Sent by older dashboards; the server reads the schema itself now. */
  tables?: string[];
  page?: string;
  allProjects?: { id: string; name: string }[];
  mode?: AiMode;
}

export interface ChatInput {
  message: string;
  history?: ChatMessage[];
  context?: AiContext;
}

/** One server-sent event of a streamed turn. */
export type AiStreamEvent =
  | { event: 'meta'; data: { provider: string; model: string; source: 'project' | 'platform'; projectId: string | null; tables: number | null } }
  | { event: 'status'; data: { phase: 'context' | 'thinking' | 'running' | 'validating' | 'summarizing'; label: string } }
  | { event: 'delta'; data: { part: 'reply' | 'followup'; text: string } }
  | { event: 'query'; data: QueryEvent }
  | { event: 'proposal'; data: ProposalEvent }
  | { event: 'done'; data: { reply: string; followup: string; stopped: boolean } }
  | { event: 'error'; data: { message: string; code?: string } };

export interface QueryEvent {
  index: number;
  sql: string;
  results: StatementResult[];
}

export interface ProposalEvent {
  index: number;
  /** Null when the SQL failed validation and cannot be approved. */
  proposal: AiProposalView | null;
  sql: string;
  statements: Pick<AnalyzedStatement, 'sql' | 'kind' | 'command' | 'destructive' | 'warning'>[];
  validation: { status: 'passed' | 'failed' | 'partial' | 'skipped'; error: string | null; notes: string[] };
  /** Set when the first draft failed validation and the assistant corrected it. */
  correctedFrom: string | null;
}

const MAX_HISTORY_TURNS = 16;
const MAX_TURN_CHARS = 12_000;
const MAX_SQL_BLOCKS = 5;

/**
 * The dashboard assistant.
 *
 * One pipeline serves Ask, Plan and Agent: load the project's real schema,
 * decide whether the message is in scope (in any language), stream the
 * model's answer, and — in Agent mode — act on the SQL it wrote. Reads run
 * at once inside a read-only transaction and the model answers from their
 * real results. Changes never run here: each becomes a validated proposal the
 * person approves, and its outcome is reported from the database, not from the
 * model.
 */
@Injectable()
export class AiService {
  private readonly logger = new Logger(AiService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly ragService: RagService,
    private readonly db: AiDatabaseService,
    private readonly proposals: AiProposalsService,
    private readonly settings: AiSettingsService,
  ) {}

  /* ───────────────────────────── legacy, non-streaming ───────────────────────────── */

  /** POST /ai/chat — kept for older dashboards: the reply in one piece, nothing executed. */
  async chat(userId: string, message: string, history: ChatMessage[], context: AiContext) {
    let reply = '';
    let error: string | null = null;
    await this.stream(
      userId,
      { message, history, context: { ...context, mode: context.mode === 'agent' ? 'plan' : context.mode } },
      (e) => {
        if (e.event === 'delta') reply += e.data.text;
        if (e.event === 'error') error = e.data.message;
      },
      undefined,
    );
    return { reply: reply || (error ? `Error: ${error}` : '') };
  }

  /* ───────────────────────────── streamed turn ───────────────────────────── */

  async stream(
    userId: string,
    input: ChatInput,
    emit: (e: AiStreamEvent) => void,
    signal: AbortSignal | undefined,
  ): Promise<void> {
    const message = String(input.message ?? '').trim();
    if (!message) throw new BadRequestException('message is required');
    const mode: AiMode = input.context?.mode === 'plan' || input.context?.mode === 'agent' ? input.context.mode : 'ask';
    const history = sanitizeHistory(input.history);

    emit({ event: 'status', data: { phase: 'context', label: 'Reading your project…' } });
    const ctx = await this.loadContext(userId, input.context ?? {});

    const llm = await this.settings.resolve(ctx.project?.id ?? null);
    if (!llm) {
      emit({
        event: 'error',
        data: {
          code: 'AI_NOT_CONFIGURED',
          message:
            'The AI assistant has no model configured. Add your own OpenAI, Gemini or Claude key under AI / Embeddings in the project, or ask the administrator to set OPENAI_API_KEY.',
        },
      });
      return;
    }
    emit({
      event: 'meta',
      data: {
        provider: llm.client.provider,
        model: llm.client.model,
        source: llm.source,
        projectId: ctx.project?.id ?? null,
        tables: ctx.schema ? ctx.schema.tables.length : null,
      },
    });

    // Scope: a missing keyword never refuses on its own; an unclear message is
    // judged by the model in whatever language it was written in.
    const verdict = quickScope(message, {
      projectNames: ctx.teamProjects.map((p) => p.name),
      tableNames: ctx.schema?.tables.map((t) => t.name) ?? [],
      hasHistory: history.length > 0,
    });
    if (verdict === 'unsure') {
      const refusal = await this.judgeScope(llm, message, signal);
      if (refusal) {
        emit({ event: 'delta', data: { part: 'reply', text: refusal } });
        emit({ event: 'done', data: { reply: refusal, followup: '', stopped: false } });
        return;
      }
    }

    let rag = '';
    try {
      rag = await this.ragService.retrieveContext(message, { projectId: ctx.project?.id });
    } catch (err: any) {
      this.logger.warn(`RAG retrieval failed, continuing without it: ${err?.message}`);
    }

    const system =
      buildSystemPrompt({
        mode,
        projectName: ctx.project?.name ?? null,
        page: input.context?.page ?? null,
        teamProjects: ctx.teamProjects.map((p) => p.name),
        schema: ctx.schema,
        schemaError: ctx.schemaError,
      }) + rag;
    const turns: LlmTurn[] = [...history, { role: 'user', content: message }];

    emit({ event: 'status', data: { phase: 'thinking', label: mode === 'agent' ? 'Writing queries…' : 'Writing…' } });
    let reply = '';
    try {
      for await (const text of llm.client.stream({ system, turns, maxTokens: 4096, temperature: 0.3, signal })) {
        reply += text;
        emit({ event: 'delta', data: { part: 'reply', text } });
      }
    } catch (err) {
      if (this.stopped(err, signal)) {
        emit({ event: 'done', data: { reply, followup: '', stopped: true } });
        return;
      }
      emit({ event: 'error', data: llmErrorData(err) });
      return;
    }

    let followup = '';
    if (mode === 'agent' && ctx.project) {
      try {
        followup = await this.actOnReply(userId, ctx.project, message, system, turns, reply, llm, emit, signal);
      } catch (err) {
        if (this.stopped(err, signal)) {
          emit({ event: 'done', data: { reply, followup, stopped: true } });
          return;
        }
        emit({ event: 'error', data: llmErrorData(err) });
        return;
      }
    }
    emit({ event: 'done', data: { reply, followup, stopped: !!signal?.aborted } });
  }

  /**
   * Agent mode: run the reply's read-only SQL, turn the rest into proposals,
   * and let the model answer from the real results. Returns the follow-up text.
   */
  private async actOnReply(
    userId: string,
    project: { id: string; name: string },
    question: string,
    system: string,
    turns: LlmTurn[],
    reply: string,
    llm: ResolvedLlm,
    emit: (e: AiStreamEvent) => void,
    signal: AbortSignal | undefined,
  ): Promise<string> {
    const blocks = extractSqlBlocks(reply).slice(0, MAX_SQL_BLOCKS);
    if (!blocks.length) return '';
    const row = await this.db.resolveProject(project.id, userId);

    const readResults: { sql: string; ok: boolean; rowCount: number | null; command: string; rows: unknown[]; error?: string }[] = [];
    let proposalsMade = 0;

    for (let i = 0; i < blocks.length; i++) {
      if (signal?.aborted) throw new LlmError('aborted', 'stopped');
      const sql = blocks[i];
      const statements = splitStatements(sql).map(analyzeStatement);

      if (isReadOnlyScript(statements)) {
        emit({ event: 'status', data: { phase: 'running', label: `Running query ${i + 1} of ${blocks.length} (read-only)…` } });
        let results: StatementResult[];
        try {
          results = await this.db.runReadOnly(row, userId, statements.map((s) => s.sql));
        } catch (err: any) {
          results = [
            { sql, ok: false, command: '', rowCount: null, fields: [], rows: [], truncated: false, error: err?.message ?? String(err), durationMs: 0 },
          ];
        }
        emit({ event: 'query', data: { index: i, sql, results } });
        for (const r of results) {
          readResults.push({ sql: r.sql, ok: r.ok, rowCount: r.rowCount, command: r.command, rows: r.rows, error: r.error });
        }
        continue;
      }

      emit({ event: 'status', data: { phase: 'validating', label: `Checking change ${i + 1} of ${blocks.length}…` } });
      const event = await this.prepareProposal(userId, row, sql, i, { system, turns, llm, signal });
      if (event.proposal) proposalsMade++;
      emit({ event: 'proposal', data: event });
    }

    if (!readResults.length) return '';

    emit({ event: 'status', data: { phase: 'summarizing', label: 'Reading the results…' } });
    const followTurns: LlmTurn[] = [
      ...turns,
      { role: 'assistant', content: reply },
      { role: 'user', content: buildResultsTurn(question, readResults, proposalsMade) },
    ];
    let followup = '';
    for await (const text of llm.client.stream({ system, turns: followTurns, maxTokens: 2048, temperature: 0.2, signal })) {
      followup += text;
      emit({ event: 'delta', data: { part: 'followup', text } });
    }
    return followup;
  }

  /**
   * Validate a proposed change with a dry run. When it fails, the model gets
   * one chance to correct it against the real error; whatever the outcome, the
   * person sees the validation result, and only SQL that passed can be stored
   * for approval.
   */
  private async prepareProposal(
    userId: string,
    row: Awaited<ReturnType<AiDatabaseService['resolveProject']>>,
    sql: string,
    index: number,
    repair: { system: string; turns: LlmTurn[]; llm: ResolvedLlm; signal?: AbortSignal } | null,
  ): Promise<ProposalEvent> {
    let current = sql;
    let correctedFrom: string | null = null;

    for (let attempt = 0; attempt < 2; attempt++) {
      const { statements, error } = normalizeProposal(current);
      if (error) {
        return {
          index,
          proposal: null,
          sql: current,
          statements: [],
          validation: { status: 'failed', error, notes: [] },
          correctedFrom,
        };
      }
      let validation;
      try {
        validation = await this.db.dryRun(row, statements);
      } catch (err: any) {
        // A guard refusal or a connection problem: show it, do not store.
        return {
          index,
          proposal: null,
          sql: current,
          statements,
          validation: { status: 'failed', error: err?.message ?? String(err), notes: [] },
          correctedFrom,
        };
      }

      if (validation.status !== 'failed') {
        const proposal = await this.proposals.create(userId, row.id, statements, validation);
        return {
          index,
          proposal: AiProposalsService.view(proposal),
          sql: current,
          statements: proposal.statements,
          validation: { status: validation.status, error: null, notes: validation.notes },
          correctedFrom,
        };
      }

      if (attempt === 0 && repair && !repair.signal?.aborted) {
        const fixed = await this.repairSql(current, validation, repair);
        if (fixed && fixed.trim() !== current.trim()) {
          correctedFrom = current;
          current = fixed;
          continue;
        }
      }
      return {
        index,
        proposal: null,
        sql: current,
        statements,
        validation: {
          status: 'failed',
          error: `Statement ${(validation.failedIndex ?? 0) + 1}: ${validation.error}`,
          notes: validation.notes,
        },
        correctedFrom,
      };
    }
    throw new Error('unreachable');
  }

  private async repairSql(
    sql: string,
    validation: { failedIndex: number | null; error: string | null },
    repair: { system: string; turns: LlmTurn[]; llm: ResolvedLlm; signal?: AbortSignal },
  ): Promise<string | null> {
    try {
      const text = await repair.llm.client.complete({
        system: repair.system,
        turns: [
          ...repair.turns,
          {
            role: 'user',
            content: `basefyio checked this SQL against the project database (in a transaction that was rolled back) and PostgreSQL rejected statement ${(validation.failedIndex ?? 0) + 1}:\n\n\`\`\`sql\n${sql}\n\`\`\`\n\nError: ${validation.error}\n\nReturn only the corrected SQL, complete, in one \`\`\`sql block. Follow the SQL rules exactly.`,
          },
        ],
        maxTokens: 2048,
        temperature: 0,
        signal: repair.signal,
      });
      return extractSqlBlocks(text)[0] ?? null;
    } catch (err: any) {
      this.logger.warn(`SQL repair attempt failed: ${err?.message ?? err}`);
      return null;
    }
  }

  /* ───────────────────────────── SQL blocks run from the panel ───────────────────────────── */

  /** The panel's Run button on a read-only block: run it read-only and return the rows. */
  async runReadOnly(userId: string, projectId: string, sql: string) {
    const statements = splitStatements(String(sql ?? '')).map(analyzeStatement);
    if (!statements.length) throw new BadRequestException('sql is required');
    if (!isReadOnlyScript(statements)) {
      throw new UnprocessableEntityException({
        code: 'AI_SQL_NEEDS_APPROVAL',
        message: 'This SQL changes data or schema. Create a proposal and approve it instead.',
      });
    }
    const row = await this.db.resolveProject(projectId, userId);
    return { results: await this.db.runReadOnly(row, userId, statements.map((s) => s.sql)) };
  }

  /** The panel's Run button on a block that changes something: validate and store it for approval. */
  async propose(userId: string, projectId: string, sql: string): Promise<ProposalEvent> {
    const text = String(sql ?? '').trim();
    if (!text) throw new BadRequestException('sql is required');
    if (text.length > 100_000) throw new BadRequestException('sql is too long');
    const row = await this.db.resolveProject(projectId, userId);
    return this.prepareProposal(userId, row, text, 0, null);
  }

  /** Run an approved proposal and report what the database holds afterwards. */
  async approve(userId: string, proposalId: string) {
    const proposal = await this.proposals.take(proposalId, userId);
    const row = await this.db.resolveProject(proposal.projectId, userId);
    const statements = proposal.statements.map((s) => analyzeStatement(s.sql));
    let result;
    try {
      result = await this.db.apply(row, userId, statements);
    } catch (err: any) {
      // Nothing ran (the connection failed before or during BEGIN): keep the
      // proposal so the person can try again.
      await this.proposals.restore(proposal);
      throw new ServiceUnavailableException(
        `The project database could not be reached, so nothing was changed: ${err?.message ?? err}`,
      );
    }
    return {
      proposalId,
      ok: result.ok,
      atomic: result.atomic,
      failedIndex: result.failedIndex,
      statements: result.statements,
      summary: describeOutcome(result),
    };
  }

  async reject(userId: string, proposalId: string) {
    await this.proposals.take(proposalId, userId);
    return { rejected: true };
  }

  /* ───────────────────────────── helpers ───────────────────────────── */

  private async loadContext(userId: string, context: AiContext) {
    const user = await this.prisma.user.findUnique({ where: { id: userId }, select: { activeTeamId: true } });
    const teamProjects = user?.activeTeamId
      ? await this.prisma.project.findMany({
          where: { teamId: user.activeTeamId, status: { not: 'DELETED' } },
          select: { id: true, name: true },
          orderBy: { createdAt: 'desc' },
          take: 300,
        })
      : [];

    let project: { id: string; name: string } | null = null;
    if (context.projectId && teamProjects.some((p) => p.id === context.projectId)) {
      project = teamProjects.find((p) => p.id === context.projectId) ?? null;
    }

    let schema: ProjectSchemaSnapshot | null = null;
    let schemaError: string | null = null;
    if (project) {
      try {
        const row = await this.db.resolveProject(project.id, userId);
        schema = await this.db.readSchema(row);
      } catch (err: any) {
        schemaError = String(err?.message ?? err).slice(0, 200);
        this.logger.warn(`AI schema read failed for ${project.id}: ${schemaError}`);
      }
    }
    return { teamProjects, project, schema, schemaError };
  }

  private async judgeScope(llm: ResolvedLlm, message: string, signal?: AbortSignal): Promise<string | null> {
    try {
      const reply = await llm.client.complete({
        system: SCOPE_JUDGE_PROMPT,
        turns: [{ role: 'user', content: message.slice(0, 2000) }],
        maxTokens: 120,
        temperature: 0,
        signal,
      });
      const { inScope, refusal } = parseScopeJudgement(reply);
      return inScope ? null : refusal;
    } catch {
      // The judge failing must not block a real question.
      return null;
    }
  }

  private stopped(err: unknown, signal?: AbortSignal): boolean {
    return !!signal?.aborted || (err instanceof LlmError && err.kind === 'aborted');
  }
}

function sanitizeHistory(history: unknown): ChatMessage[] {
  if (!Array.isArray(history)) return [];
  const turns = history
    .filter((m): m is ChatMessage => !!m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string')
    .map((m) => ({ role: m.role, content: m.content.slice(0, MAX_TURN_CHARS) }))
    .filter((m) => m.content.trim())
    .slice(-MAX_HISTORY_TURNS);
  // Providers want the conversation to start with the user and alternate.
  const out: ChatMessage[] = [];
  for (const m of turns) {
    if (!out.length && m.role !== 'user') continue;
    const last = out[out.length - 1];
    if (last && last.role === m.role) last.content += `\n\n${m.content}`;
    else out.push({ ...m });
  }
  if (out.length && out[out.length - 1].role === 'user') {
    // The new message follows; merge a dangling user turn into the context.
    out.push({ role: 'assistant', content: '(no reply)' });
  }
  return out;
}

function llmErrorData(err: unknown): { message: string; code?: string } {
  if (err instanceof LlmError) {
    const codes: Record<LlmError['kind'], string> = {
      auth: 'AI_API_KEY_REJECTED',
      quota: 'AI_QUOTA',
      input: 'AI_REQUEST_REJECTED',
      unavailable: 'AI_UNAVAILABLE',
      refusal: 'AI_REFUSED',
      aborted: 'AI_STOPPED',
    };
    return { message: err.message, code: codes[err.kind] };
  }
  return { message: (err as any)?.message ?? String(err) };
}

export { sanitizeHistory as _sanitizeHistoryForTest };
