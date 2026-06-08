'use client';

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { usePathname } from 'next/navigation';
import { toast } from 'sonner';
import { api } from '@/lib/api';
import {
  BASEFYIO_AI_SEND_EVENT,
  buildSqlRunErrorPrompt,
  dispatchbasefyioAiMessage,
  type BasefyioAiSendDetail,
} from '@/lib/basefyio-ai-events';
import { dispatchbasefyioNotification } from '@/lib/notifications-context';
import { useActiveTeam } from '@/app/dashboard/layout';
import { cn } from '@/lib/utils';
import {
  Bot,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  ChevronUp,
  Copy,
  Loader2,
  Pencil,
  Play,
  Plus,
  RotateCcw,
  Send,
  Sparkles,
  MessageCircle,
  ClipboardList,
  Zap,
  X,
  XCircle,
} from 'lucide-react';


// ── Types ──────────────────────────────────────────────────────────────────────
type AiMode = 'ask' | 'plan' | 'agent';

interface AgentStep {
  sql: string;
  rows: number;
  preview?: string;
  error?: string;
}

interface Message {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  mode?: AiMode;
  agentSteps?: AgentStep[];
}

interface ChatSession {
  id: string;
  messages: Message[];
}

interface AiContext {
  projectId?: string;
  projectName?: string;
  tables?: string[];
  page?: string;
  allProjects?: { id: string; name: string }[];
  mode?: AiMode;
}

// ── Helpers ────────────────────────────────────────────────────────────────────
function genId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

function getSessionTitle(session: ChatSession): string {
  const first = session.messages.find((m) => m.role === 'user');
  if (!first) return 'New chat';
  return first.content.length > 22 ? first.content.slice(0, 22) + '…' : first.content;
}

function loadSessions(key: string): ChatSession[] {
  try {
    const raw = localStorage.getItem(key);
    if (raw) {
      const parsed = JSON.parse(raw) as ChatSession[];
      if (Array.isArray(parsed) && parsed.length > 0) return parsed;
    }
  } catch {}
  return [{ id: genId(), messages: [] }];
}

function saveSessions(sessions: ChatSession[], key: string) {
  try {
    const trimmed = sessions
      .slice(-10)
      .map((s) => ({ ...s, messages: s.messages.slice(-40) }));
    localStorage.setItem(key, JSON.stringify(trimmed));
  } catch {}
}

function extractSQLBlocks(text: string): string[] {
  const regex = /```sql\n?([\s\S]*?)```/gi;
  const blocks: string[] = [];
  let match: RegExpExecArray | null;
  while ((match = regex.exec(text)) !== null) {
    const sql = match[1].trim();
    if (sql) blocks.push(sql);
  }
  return blocks;
}

function parseContent(content: string) {
  type Part = { type: 'text' | 'sql' | 'code'; value: string; lang?: string };
  const parts: Part[] = [];
  const regex = /```(\w*)\n?([\s\S]*?)```/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(content)) !== null) {
    if (match.index > lastIndex)
      parts.push({ type: 'text', value: content.slice(lastIndex, match.index) });
    const lang = match[1].toLowerCase();
    parts.push({ type: lang === 'sql' ? 'sql' : 'code', value: match[2].trim(), lang: match[1] || 'code' });
    lastIndex = match.index + match[0].length;
  }
  if (lastIndex < content.length)
    parts.push({ type: 'text', value: content.slice(lastIndex) });
  return parts;
}

// ── Mode config ────────────────────────────────────────────────────────────────
const MODES: {
  id: AiMode;
  label: string;
  icon: React.ElementType;
  description: string;
  placeholder: string;
}[] = [
  {
    id: 'ask',
    label: 'Ask',
    icon: MessageCircle,
    description: 'Quick Q&A',
    placeholder: 'Ask anything…',
  },
  {
    id: 'plan',
    label: 'Plan',
    icon: ClipboardList,
    description: 'Step-by-step planning',
    placeholder: 'What do you want to plan?',
  },
  {
    id: 'agent',
    label: 'Agent',
    icon: Zap,
    description: 'Runs SQL automatically',
    placeholder: 'What should I analyze?',
  },
];

function getSuggestions(mode: AiMode, page?: string, hasTables?: boolean): string[] {
  void page;
  if (mode === 'ask') {
    if (hasTables) {
      return ['What tables exist?', 'How do I set up RLS?', 'When do I need indexes?'];
    }
    return ['What can basefyio do?', 'How do I connect to PostgreSQL?'];
  }
  if (mode === 'plan') {
    if (hasTables) {
      return ['Draft a migration plan for my schema', 'Plan a soft-delete strategy'];
    }
    return ['Plan a new project schema', 'How should I design auth?'];
  }
  if (hasTables) {
    return ['Analyze all tables and summarize', 'Find missing indexes'];
  }
  return ['Review my project and list recommendations', 'Run a database health check'];
}

// ── Main component ────────────────────────────────────────────────────────────
export function AiAssistant() {
  const pathname = usePathname();
  const { activeTeamId, profile } = useActiveTeam();

  // ── Visibility ──────────────────────────────────────────────────────────
  const [open, setOpen] = useState<boolean>(() => {
    if (typeof window === 'undefined') return true;
    return (localStorage.getItem('basefyio_ai_open') ?? 'true') === 'true';
  });
  const openRef = useRef(open);
  openRef.current = open;

  // ── Resizable width ──────────────────────────────────────────────────────
  const [sidebarWidth, setSidebarWidth] = useState<number>(() => {
    if (typeof window === 'undefined') return 380;
    return parseInt(localStorage.getItem('basefyio_ai_width') || '380', 10);
  });
  const isDragging = useRef(false);
  const dragStartX = useRef(0);
  const dragStartWidth = useRef(380);

  const onDragStart = useCallback((e: React.MouseEvent) => {
    isDragging.current = true;
    dragStartX.current = e.clientX;
    dragStartWidth.current = sidebarWidth;
    e.preventDefault();
  }, [sidebarWidth]);

  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      if (!isDragging.current) return;
      const delta = dragStartX.current - e.clientX;
      const next = Math.min(Math.max(dragStartWidth.current + delta, 280), 760);
      setSidebarWidth(next);
    };
    const onUp = () => {
      if (isDragging.current) {
        isDragging.current = false;
        localStorage.setItem('basefyio_ai_width', dragStartWidth.current.toString());
      }
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
    return () => { document.removeEventListener('mousemove', onMove); document.removeEventListener('mouseup', onUp); };
  }, []);

  // ── Storage key: per user + per team ─────────────────────────────────────
  // e.g. "basefyio_ai_sessions_abc123_team456"
  // null means we don't have user/team info yet — sessions are not persisted.
  const storageKey = profile?.id && activeTeamId
    ? `basefyio_ai_sessions_${profile.id}_${activeTeamId}`
    : null;

  // Track the previous key so we know when to reload sessions
  const prevStorageKeyRef = useRef<string | null>(null);

  // ── Sessions ─────────────────────────────────────────────────────────────
  const initSession = (): ChatSession => ({ id: genId(), messages: [] });
  const [sessions, setSessions] = useState<ChatSession[]>(() => [initSession()]);
  const [activeSessionId, setActiveSessionId] = useState<string>(() => sessions[0].id);

  // Load sessions from localStorage when storageKey is first available or changes (team switch)
  useEffect(() => {
    if (!storageKey) return;
    if (storageKey === prevStorageKeyRef.current) return;
    prevStorageKeyRef.current = storageKey;
    const loaded = loadSessions(storageKey);
    setSessions(loaded);
    setActiveSessionId(loaded[loaded.length - 1].id);
  }, [storageKey]);

  // Persist sessions whenever they change (only when we have a valid key)
  useEffect(() => {
    if (!storageKey) return;
    saveSessions(sessions, storageKey);
  }, [sessions, storageKey]);

  const activeSession = sessions.find((s) => s.id === activeSessionId) ?? sessions[0];
  const messages = activeSession?.messages ?? [];
  /** Only the latest user turn may use `sticky`; otherwise multiple stickies stack at top-0 and overlap. */
  const latestUserMessageId = useMemo(() => {
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].role === 'user') return messages[i].id;
    }
    return null;
  }, [messages]);
  const messagesRef = useRef<Message[]>([]);
  messagesRef.current = messages;

  const setMessages = useCallback((updater: (prev: Message[]) => Message[]) => {
    setSessions((prev) =>
      prev.map((s) =>
        s.id === activeSessionId ? { ...s, messages: updater(s.messages) } : s,
      ),
    );
  }, [activeSessionId]);

  const newChat = useCallback(() => {
    const id = genId();
    setSessions((prev) => [...prev, { id, messages: [] }]);
    setActiveSessionId(id);
  }, []);

  const closeSession = useCallback((id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    setSessions((prev) => {
      if (prev.length === 1) return [{ id: genId(), messages: [] }];
      const next = prev.filter((s) => s.id !== id);
      if (activeSessionId === id) setActiveSessionId(next[next.length - 1].id);
      return next;
    });
  }, [activeSessionId]);

  // ── Mode ─────────────────────────────────────────────────────────────────
  const [mode, setMode] = useState<AiMode>(() => {
    if (typeof window === 'undefined') return 'ask';
    return (localStorage.getItem('basefyio_ai_mode') as AiMode) ?? 'ask';
  });
  const [modeOpen, setModeOpen] = useState(false);
  const modeRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (modeRef.current && !modeRef.current.contains(e.target as Node)) setModeOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  const changeMode = (m: AiMode) => {
    setMode(m);
    localStorage.setItem('basefyio_ai_mode', m);
    setModeOpen(false);
  };

  // ── AI context ────────────────────────────────────────────────────────────
  const [context, setContext] = useState<AiContext>({});
  const [contextLoading, setContextLoading] = useState(false);
  const [loading, setLoading] = useState(false);
  const [agentStatus, setAgentStatus] = useState<string | null>(null);
  const [runningSQL, setRunningSQL] = useState<string | null>(null);
  const [input, setInput] = useState('');

  const messagesEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const tabsRef = useRef<HTMLDivElement>(null);

  // Page context
  useEffect(() => {
    if (!pathname) return;
    const projectMatch = pathname.match(/\/dashboard\/projects\/([^/]+)/);
    const projectId = projectMatch?.[1];
    if (projectId && projectId !== 'undefined') {
      const subPage = pathname.includes('/sql') ? 'sql'
        : pathname.includes('/tables') ? 'tables'
        : pathname.includes('/auth') ? 'auth'
        : pathname.includes('/storage') ? 'storage'
        : pathname.includes('/connect') ? 'connect'
        : pathname.includes('/logs') ? 'logs'
        : 'project-detail';
      setContext((p) => (p.projectId === projectId && p.page === subPage) ? p : { projectId, page: subPage });
      Promise.all([
        api.projects.get(projectId).catch(() => null),
        api.projects.tables(projectId).catch(() => []),
      ]).then(([project, tables]) =>
        setContext((p) => ({ ...p, projectName: project?.name, tables: (tables as any[]).map((t: any) => t.name) })),
      );
    } else if (pathname === '/dashboard/projects') {
      setContext({ page: 'projects' });
    } else {
      setContext({ page: 'dashboard' });
    }
  }, [pathname]);

  useEffect(() => {
    if (context.page === 'projects' && activeTeamId) {
      api.projects.list(activeTeamId)
        .then((ps) => setContext((p) => ({ ...p, allProjects: ps.map((x) => ({ id: x.id, name: x.name })) })))
        .catch(() => {});
    }
  }, [context.page, activeTeamId]);

  useEffect(() => {
    if (open) setTimeout(() => messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' }), 50);
  }, [messages, open, agentStatus]);

  useEffect(() => {
    if (open) setTimeout(() => inputRef.current?.focus(), 150);
  }, [open, activeSessionId]);

  // Smart project context from mention
  const loadProjectContext = useCallback(async (text: string): Promise<AiContext> => {
    if (context.projectId) return context;
    const projects = context.allProjects ?? [];
    const found = projects.find((p) => text.toLowerCase().includes(p.name.toLowerCase()));
    if (!found) return context;
    setContextLoading(true);
    try {
      const [project, tables] = await Promise.all([
        api.projects.get(found.id).catch(() => null),
        api.projects.tables(found.id).catch(() => []),
      ]);
      const loaded: AiContext = { ...context, projectId: found.id, projectName: project?.name ?? found.name, tables: (tables as any[]).map((t: any) => t.name) };
      setContext(loaded);
      return loaded;
    } catch { return context; }
    finally { setContextLoading(false); }
  }, [context]);

  // Agent loop
  const runAgentLoop = useCallback(async (
    userMessage: string,
    ctx: AiContext,
    history: { role: 'user' | 'assistant'; content: string }[],
  ): Promise<{ content: string; agentSteps?: AgentStep[] }> => {
    setAgentStatus('🔍 Generating queries…');
    const { reply: planReply } = await api.ai.chat(userMessage, history, { ...ctx, mode: 'agent' });
    const sqlBlocks = extractSQLBlocks(planReply).slice(0, 5);
    if (sqlBlocks.length === 0 || !ctx.projectId) return { content: planReply };

    const agentSteps: AgentStep[] = [];
    const summaries: string[] = [];
    for (let i = 0; i < sqlBlocks.length; i++) {
      const sql = sqlBlocks[i];
      setAgentStatus(`⚡ Running SQL… (${i + 1}/${sqlBlocks.length})`);
      try {
        const result = await api.sql.execute(ctx.projectId, sql);
        const rows = result.rowCount ?? result.rows?.length ?? 0;
        const preview = JSON.stringify(result.rows?.slice(0, 20) ?? []);
        agentSteps.push({ sql, rows, preview });
        summaries.push(`--- Query ${i + 1} ---\n${sql}\n\nResult (${rows} rows):\n${preview}`);
      } catch (err: any) {
        agentSteps.push({ sql, rows: 0, error: err.message });
        summaries.push(`--- Query ${i + 1} ---\n${sql}\n\nError: ${err.message}`);
      }
    }
    setAgentStatus('📊 Analyzing results…');
    const feedbackMsg = `I executed the SQL below. Answer the user's question ("${userMessage}") directly from these results, with numbers and analysis where helpful. Do not generate new SQL.\n\n${summaries.join('\n\n')}`;
    const { reply: final } = await api.ai.chat(feedbackMsg,
      [...history.slice(-6), { role: 'user', content: userMessage }, { role: 'assistant', content: planReply }],
      { ...ctx, mode: 'agent' });
    return { content: final, agentSteps };
  }, []);

  // Send
  const sendMessage = useCallback(async (text: string) => {
    const trimmed = text.trim();
    if (!trimmed || loading) return;
    const historyBefore = messagesRef.current.slice(-12).map((m) => ({ role: m.role, content: m.content }));
    setMessages((p) => [...p, { id: genId(), role: 'user', content: trimmed, mode }]);
    setInput('');
    setLoading(true);
    try {
      const ctx = await loadProjectContext(trimmed);
      const history = historyBefore;
      if (mode === 'agent') {
        const { content, agentSteps } = await runAgentLoop(trimmed, ctx, history);
        setMessages((p) => [...p, { id: genId(), role: 'assistant', content, mode, agentSteps }]);
        if (!openRef.current) {
          dispatchbasefyioNotification({
            type: 'ai',
            title: 'AI replied',
            message: 'New AI response is ready in assistant.',
          });
        }
      } else {
        const { reply } = await api.ai.chat(trimmed, history, { ...ctx, mode });
        setMessages((p) => [...p, { id: genId(), role: 'assistant', content: reply, mode }]);
        if (!openRef.current) {
          dispatchbasefyioNotification({
            type: 'ai',
            title: 'AI replied',
            message: 'New AI response is ready in assistant.',
          });
        }
      }
    } catch (err: any) {
      toast.error('AI error: ' + err.message);
    } finally { setLoading(false); setAgentStatus(null); }
  }, [loading, loadProjectContext, mode, runAgentLoop, setMessages]);

  const sendMessageRef = useRef(sendMessage);
  sendMessageRef.current = sendMessage;

  useEffect(() => {
    const onKbAiSend = (e: Event) => {
      const detail = (e as CustomEvent<BasefyioAiSendDetail>).detail;
      const msg = detail?.message?.trim();
      if (!msg) return;
      setOpen(true);
      localStorage.setItem('basefyio_ai_open', 'true');
      const m = detail.mode;
      if (m === 'ask' || m === 'plan' || m === 'agent') {
        setMode(m);
        localStorage.setItem('basefyio_ai_mode', m);
      }
      const run = () => {
        void sendMessageRef.current(msg);
      };
      if (typeof requestAnimationFrame === 'function') {
        requestAnimationFrame(() => setTimeout(run, 0));
      } else {
        setTimeout(run, 0);
      }
    };
    window.addEventListener(BASEFYIO_AI_SEND_EVENT, onKbAiSend as EventListener);
    return () => window.removeEventListener(BASEFYIO_AI_SEND_EVENT, onKbAiSend as EventListener);
  }, []);

  const runSQL = useCallback(async (sql: string) => {
    if (!context.projectId) {
      toast.error('Open a project to run SQL');
      return;
    }
    setRunningSQL(sql);
    try {
      const result = await api.sql.execute(context.projectId, sql);
      const rows = result.rowCount ?? 0;
      toast.success(`Query finished — ${rows} row${rows === 1 ? '' : 's'}`);
      const preview = result.rows?.length
        ? `\`\`\`\n${JSON.stringify(result.rows.slice(0, 5), null, 2)}\n\`\`\``
        : 'Query ran successfully.';
      setMessages((p) => [
        ...p,
        { id: genId(), role: 'assistant', content: `**Result** (${rows} row${rows === 1 ? '' : 's'}):\n${preview}`, mode },
      ]);
    } catch (err: any) {
      const errMsg = (err?.message ?? String(err)).trim();
      const summary = errMsg.toLowerCase().startsWith('sql error')
        ? errMsg
        : `SQL error: ${errMsg}`;
      toast.error(summary, {
        duration: 20_000,
        action: {
          label: 'Send to chat',
          onClick: () => {
            dispatchbasefyioAiMessage({
              message: buildSqlRunErrorPrompt(sql, errMsg),
              mode: 'ask',
            });
          },
        },
      });
    }
    finally { setRunningSQL(null); }
  }, [context.projectId, mode, setMessages]);

  const currentMode = MODES.find((m) => m.id === mode)!;
  const suggestions = getSuggestions(mode, context.page, (context.tables?.length ?? 0) > 0);
  const hasProject = !!context.projectId;

  const toggle = () => {
    setOpen((o) => { const n = !o; localStorage.setItem('basefyio_ai_open', n ? 'true' : 'false'); return n; });
  };

  // ── Closed state ──────────────────────────────────────────────────────────
  if (!open) {
    return (
      <div className="w-10 shrink-0 border-l bg-card flex flex-col items-center py-5">
        <button onClick={toggle} title="Open AI assistant"
          className="flex flex-col items-center gap-2 rounded-lg p-2 hover:bg-accent transition-colors group">
          <Sparkles className="h-4 w-4 text-primary group-hover:scale-110 transition-transform" />
          <span className="text-[9px] font-semibold tracking-widest text-muted-foreground uppercase"
            style={{ writingMode: 'vertical-rl', transform: 'rotate(180deg)' }}>AI</span>
        </button>
      </div>
    );
  }

  // ── Open state ────────────────────────────────────────────────────────────
  return (
    <div className="flex shrink-0" style={{ width: sidebarWidth }}>
      {/* Drag-to-resize handle */}
      <div
        onMouseDown={onDragStart}
        className="w-1 shrink-0 cursor-col-resize hover:bg-primary/40 transition-colors group relative"
        title="Drag to resize width"
      >
        <div className="absolute inset-y-0 left-0 w-4 -translate-x-1.5" />
      </div>

      {/* Sidebar body */}
      <div className="flex-1 border-l bg-card flex flex-col overflow-hidden min-w-0">

        {/* Header */}
        <div className="flex items-center gap-2.5 border-b px-3 py-2.5 shrink-0">
          <div className="flex h-6 w-6 items-center justify-center rounded-md bg-gradient-to-br from-blue-500 to-blue-700">
            <Bot className="h-3.5 w-3.5 text-white" />
          </div>
          <div className="flex-1 min-w-0">
            <p className="text-xs font-semibold leading-tight truncate">
              basefyio AI
              {context.projectName && (
                <span className="ml-1.5 font-normal text-muted-foreground">· {context.projectName}</span>
              )}
            </p>
          </div>
          <div className="flex items-center gap-0.5 shrink-0">
            <button onClick={newChat} title="New chat"
              className="rounded p-1 hover:bg-accent transition-colors text-muted-foreground">
              <Plus className="h-3.5 w-3.5" />
            </button>
            <button onClick={toggle} title="Collapse panel"
              className="rounded p-1 hover:bg-accent transition-colors text-muted-foreground">
              <ChevronRight className="h-3.5 w-3.5" />
            </button>
          </div>
        </div>

        {/* Session tabs */}
        <div
          ref={tabsRef}
          className="flex items-center gap-0.5 border-b px-1 py-1 overflow-x-auto scrollbar-none shrink-0 bg-muted/40"
          style={{ scrollbarWidth: 'none' }}
        >
          {sessions.map((session) => {
            const active = session.id === activeSessionId;
            const title = getSessionTitle(session);
            return (
              <button
                key={session.id}
                onClick={() => setActiveSessionId(session.id)}
                className={`group flex items-center gap-1 rounded px-2 py-1 text-[11px] font-medium whitespace-nowrap transition-colors shrink-0 ${
                  active
                    ? 'bg-background text-foreground shadow-sm'
                    : 'text-muted-foreground hover:bg-background/60 hover:text-foreground'
                }`}
              >
                <span className="max-w-[100px] truncate">{title}</span>
                <span
                  onClick={(e) => closeSession(session.id, e)}
                  className={`ml-0.5 rounded p-0.5 transition-colors ${
                    active
                      ? 'hover:bg-muted text-muted-foreground'
                      : 'text-transparent group-hover:text-muted-foreground hover:bg-muted'
                  }`}
                >
                  <X className="h-2.5 w-2.5" />
                </span>
              </button>
            );
          })}
          <button onClick={newChat} title="New chat"
            className="ml-0.5 shrink-0 rounded p-1 hover:bg-background/60 transition-colors text-muted-foreground">
            <Plus className="h-3 w-3" />
          </button>
        </div>

        {/* Messages */}
        <div className="flex-1 overflow-y-auto p-3 space-y-3 min-h-0">
          {messages.length === 0 ? (
            <div className="flex flex-col items-center justify-center h-full gap-4 px-2">
              <div className="flex h-11 w-11 items-center justify-center rounded-2xl bg-gradient-to-br from-blue-500 to-blue-700 shadow">
                <currentMode.icon className="h-5 w-5 text-white" />
              </div>
              <div className="text-center">
                <p className="text-sm font-semibold">{currentMode.label} mode</p>
                <p className="text-xs text-muted-foreground mt-0.5">
                  {hasProject
                    ? `"${context.projectName}" · ${currentMode.description}`
                    : currentMode.description}
                </p>
              </div>
              {/* Project hint */}
              {context.page === 'projects' && !context.projectId && (context.allProjects?.length ?? 0) > 0 && (
                <div className="w-full rounded-lg border border-blue-200 bg-blue-50 dark:bg-blue-950/30 dark:border-blue-800 px-3 py-2 text-[11px] text-blue-700 dark:text-blue-300">
                  💡 Mention a project by name to load its context — e.g.{' '}
                  <em>&quot;{context.allProjects![0].name}&quot;</em>
                </div>
              )}
              <div className="w-full space-y-1.5">
                {suggestions.map((s) => (
                  <button key={s} onClick={() => sendMessage(s)}
                    className="w-full rounded-lg border bg-background px-3 py-2 text-left text-xs hover:bg-accent transition-colors text-foreground/80 hover:text-foreground">
                    {s}
                  </button>
                ))}
              </div>
            </div>
          ) : (
            messages.map((msg) => (
              <MessageBubble
                key={msg.id}
                message={msg}
                stickUserBubble={msg.role === 'user' && msg.id === latestUserMessageId}
                canRunSQL={hasProject && msg.mode !== 'agent'}
                runningSQL={runningSQL}
                onRunSQL={runSQL}
                onResend={sendMessage}
              />
            ))
          )}

          {/* Loading */}
          {(loading || contextLoading) && (
            <div className="flex items-start gap-2">
              <div className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-gradient-to-br from-blue-500 to-blue-700">
                <Bot className="h-3.5 w-3.5 text-white" />
              </div>
              <div className="rounded-2xl rounded-tl-sm bg-muted px-3 py-2 flex items-center gap-2">
                <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground shrink-0" />
                <span className="text-xs text-muted-foreground">
                  {agentStatus ?? (contextLoading ? 'Loading project data…' : 'Preparing reply…')}
                </span>
              </div>
            </div>
          )}
          <div ref={messagesEndRef} />
        </div>

        {/* Input area */}
        <div className="border-t p-2.5 shrink-0 space-y-2">
          {/* Textarea */}
          <div className="rounded-xl border bg-background focus-within:ring-1 focus-within:ring-primary/40">
            <textarea
              ref={inputRef}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(input); }
              }}
              placeholder={currentMode.placeholder}
              rows={2}
              className="w-full resize-none bg-transparent px-3 pt-2.5 pb-1 text-sm outline-none placeholder:text-muted-foreground max-h-36"
              style={{ fieldSizing: 'content' } as React.CSSProperties}
            />

            {/* Toolbar row */}
            <div className="flex items-center justify-between px-2 pb-2">
              {/* Mode selector */}
              <div ref={modeRef} className="relative">
                <button
                  onClick={() => setModeOpen((o) => !o)}
                  className={`flex items-center gap-1.5 rounded-md border px-2 py-1 text-[11px] font-medium transition-colors hover:bg-accent ${
                    mode === 'ask' ? 'border-blue-200 text-blue-600 bg-blue-50 dark:bg-blue-950/30 dark:border-blue-800 dark:text-blue-400'
                    : mode === 'plan' ? 'border-violet-200 text-violet-600 bg-violet-50 dark:bg-violet-950/30 dark:border-violet-800 dark:text-violet-400'
                    : 'border-amber-200 text-amber-600 bg-amber-50 dark:bg-amber-950/30 dark:border-amber-800 dark:text-amber-400'
                  }`}
                >
                  <currentMode.icon className="h-3 w-3" />
                  <span>{currentMode.label}</span>
                  <ChevronDown className="h-2.5 w-2.5 opacity-60" />
                </button>

                {modeOpen && (
                  <div className="absolute bottom-full left-0 mb-1.5 w-52 rounded-xl border bg-popover shadow-lg overflow-hidden z-50">
                    {MODES.map((m) => {
                      const Icon = m.icon;
                      const active = mode === m.id;
                      return (
                        <button key={m.id} onClick={() => changeMode(m.id)}
                          className={`flex w-full items-start gap-3 px-3 py-2.5 text-left transition-colors hover:bg-accent ${active ? 'bg-accent' : ''}`}>
                          <Icon className={`h-4 w-4 mt-0.5 shrink-0 ${
                            m.id === 'ask' ? 'text-blue-500' : m.id === 'plan' ? 'text-violet-500' : 'text-amber-500'
                          }`} />
                          <div>
                            <p className="text-xs font-semibold">{m.label}</p>
                            <p className="text-[10px] text-muted-foreground mt-0.5">{m.description}</p>
                          </div>
                          {active && <div className="ml-auto mt-0.5 h-1.5 w-1.5 rounded-full bg-primary shrink-0" />}
                        </button>
                      );
                    })}
                  </div>
                )}
              </div>

              {/* Right: clear + send */}
              <div className="flex items-center gap-1">
                {messages.length > 0 && (
                  <button onClick={() => setMessages(() => [])} title="Clear chat"
                    className="rounded-md p-1.5 hover:bg-accent transition-colors text-muted-foreground">
                    <RotateCcw className="h-3.5 w-3.5" />
                  </button>
                )}
                <button
                  onClick={() => sendMessage(input)}
                  disabled={!input.trim() || loading || contextLoading}
                  className="flex h-7 w-7 items-center justify-center rounded-lg bg-primary text-white disabled:opacity-40 hover:opacity-90 transition-opacity"
                >
                  <Send className="h-3.5 w-3.5" />
                </button>
              </div>
            </div>
          </div>

          {/* Agent hint */}
          {mode === 'agent' && hasProject && (
            <p className="text-[10px] text-center text-amber-600/70 dark:text-amber-400/60">
              ⚡ Agent mode runs generated SQL automatically against this project
            </p>
          )}
        </div>
      </div>
    </div>
  );
}

// ── Agent trace ────────────────────────────────────────────────────────────────
function AgentTrace({ steps }: { steps: AgentStep[] }) {
  const [expanded, setExpanded] = useState(false);
  return (
    <div className="rounded-lg border bg-background/60 text-xs overflow-hidden w-full">
      <button onClick={() => setExpanded((e) => !e)}
        className="flex w-full items-center gap-2 px-3 py-2 hover:bg-accent transition-colors">
        <Zap className="h-3 w-3 text-amber-500 shrink-0" />
        <span className="font-medium flex-1 text-left text-[11px]">
          Agent ran — {steps.length} {steps.length === 1 ? 'query' : 'queries'}
          {steps.some((s) => s.error) && <span className="ml-1 text-red-500">(errors)</span>}
        </span>
        {expanded
          ? <ChevronUp className="h-3 w-3 text-muted-foreground" />
          : <ChevronDown className="h-3 w-3 text-muted-foreground" />}
      </button>
      {expanded && (
        <div className="border-t divide-y">
          {steps.map((step, i) => (
            <div key={i} className="px-3 py-2 space-y-1.5">
              <div className="flex items-center gap-1.5">
                {step.error
                  ? <XCircle className="h-3 w-3 text-red-500 shrink-0" />
                  : <CheckCircle2 className="h-3 w-3 text-green-500 shrink-0" />}
                <span className={`text-[11px] font-medium ${step.error ? 'text-red-600' : 'text-green-700 dark:text-green-400'}`}>
                  {step.error ? 'Error' : `${step.rows} row${step.rows === 1 ? '' : 's'} returned`}
                </span>
              </div>
              <pre className="text-[10px] text-muted-foreground font-mono whitespace-pre-wrap break-words bg-muted rounded p-1.5 leading-relaxed">
                {step.sql.length > 140 ? step.sql.slice(0, 140) + '…' : step.sql}
              </pre>
              {step.error && <p className="text-[10px] text-red-500">{step.error}</p>}
              {!step.error && step.preview && step.preview !== '[]' && (
                <pre className="text-[10px] text-muted-foreground font-mono whitespace-pre-wrap break-words max-h-20 overflow-y-auto bg-muted/50 rounded p-1">
                  {step.preview.length > 400 ? step.preview.slice(0, 400) + '…' : step.preview}
                </pre>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ── Message bubble ─────────────────────────────────────────────────────────────
const MODE_BADGE: Record<AiMode, string> = {
  ask: 'bg-blue-100 text-blue-600 dark:bg-blue-900/40 dark:text-blue-400',
  plan: 'bg-violet-100 text-violet-600 dark:bg-violet-900/40 dark:text-violet-400',
  agent: 'bg-amber-100 text-amber-600 dark:bg-amber-900/40 dark:text-amber-400',
};

function MessageBubble({
  message,
  stickUserBubble,
  canRunSQL,
  runningSQL,
  onRunSQL,
  onResend,
}: {
  message: Message;
  /** Only true for the most recent user message — avoids stacked stickies overlapping. */
  stickUserBubble?: boolean;
  canRunSQL: boolean;
  runningSQL: string | null;
  onRunSQL: (sql: string) => void;
  onResend: (text: string) => Promise<void>;
}) {
  const isUser = message.role === 'user';
  const parts = parseContent(message.content);
  const [expanded, setExpanded] = useState(false);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(message.content);
  const isLikelyLong = message.content.length > 120 || message.content.includes('\n');

  // ── User message: optional sticky for latest prompt only (scroll long replies) ──
  if (isUser) {
    return (
      <div
        className={cn(
          'w-full rounded-xl border border-border/60 bg-card px-3.5 py-2.5 shadow-sm',
          stickUserBubble && 'sticky top-0 z-10',
        )}
      >
        {!editing ? (
          <>
            <p
              className={cn(
                'text-xs text-foreground leading-relaxed whitespace-pre-wrap break-words',
                isLikelyLong && !expanded && 'line-clamp-2',
              )}
              title={message.content}
            >
              {message.content}
            </p>
            {isLikelyLong && (
              <div className="mt-1.5 flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => setExpanded((v) => !v)}
                  className="text-[10px] font-medium text-primary hover:underline"
                >
                  {expanded ? 'Show less' : 'Show full'}
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setDraft(message.content);
                    setEditing(true);
                    setExpanded(true);
                  }}
                  className="inline-flex items-center gap-1 text-[10px] font-medium text-muted-foreground hover:text-foreground"
                >
                  <Pencil className="h-3 w-3" />
                  Edit & resend
                </button>
              </div>
            )}
          </>
        ) : (
          <div className="space-y-2">
            <textarea
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              rows={4}
              className="w-full resize-y rounded-md border bg-background px-2 py-1.5 text-xs outline-none focus:ring-1 focus:ring-primary/40"
            />
            <div className="flex items-center justify-end gap-2">
              <button
                type="button"
                onClick={() => {
                  setEditing(false);
                  setDraft(message.content);
                }}
                className="text-[10px] text-muted-foreground hover:text-foreground"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => {
                  const next = draft.trim();
                  if (!next) return;
                  void onResend(next);
                  setEditing(false);
                }}
                className="inline-flex items-center gap-1 rounded bg-primary px-2 py-1 text-[10px] font-medium text-white hover:opacity-90"
              >
                <Send className="h-3 w-3" />
                Send again
              </button>
            </div>
          </div>
        )}
      </div>
    );
  }

  // ── Assistant message ────────────────────────────────────────────────────
  return (
    <div className="flex items-start gap-2">
      <div className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-gradient-to-br from-blue-500 to-blue-700">
        <Bot className="h-3 w-3 text-white" />
      </div>

      <div className="flex-1 min-w-0 space-y-1.5 flex flex-col items-start">
        {message.mode && (
          <span className={`text-[9px] font-semibold uppercase tracking-wider px-1.5 py-0.5 rounded ${MODE_BADGE[message.mode]}`}>
            {message.mode}
          </span>
        )}
        {message.agentSteps && message.agentSteps.length > 0 && (
          <AgentTrace steps={message.agentSteps} />
        )}
        {parts.map((part, i) => {
          if (part.type === 'text') {
            if (!part.value.trim()) return null;
            // Escape HTML first to prevent XSS from AI responses or injected content
            const escaped = part.value
              .replace(/&/g, '&amp;')
              .replace(/</g, '&lt;')
              .replace(/>/g, '&gt;')
              .replace(/"/g, '&quot;');
            const html = escaped
              .replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>')
              .replace(/`([^`]+)`/g, '<code class="rounded bg-muted px-1 py-0.5 font-mono text-[10px]">$1</code>')
              .replace(/\n/g, '<br>');
            return (
              <div key={i}
                className="rounded-2xl rounded-tl-sm bg-muted px-3 py-2 text-xs leading-relaxed text-foreground"
                dangerouslySetInnerHTML={{ __html: html }}
              />
            );
          }
          if (part.type === 'sql' || part.type === 'code') {
            const isSql = part.type === 'sql';
            const isRunning = runningSQL === part.value;
            return (
              <div key={i} className="w-full rounded-xl border bg-zinc-950 overflow-hidden text-xs">
                <div className="flex items-center justify-between px-3 py-1.5 border-b border-white/10">
                  <span className="text-zinc-400 font-mono uppercase tracking-wider text-[10px]">
                    {isSql ? 'SQL' : part.lang}
                  </span>
                  <div className="flex items-center gap-1.5">
                    <button
                      onClick={() => {
                        navigator.clipboard.writeText(part.value);
                        toast.success('Copied');
                      }}
                      className="flex items-center gap-1 rounded px-1.5 py-0.5 text-zinc-400 hover:text-white hover:bg-white/10 transition-colors">
                      <Copy className="h-3 w-3" />
                      <span className="text-[10px]">Copy</span>
                    </button>
                    {isSql && canRunSQL && (
                      <button onClick={() => onRunSQL(part.value)} disabled={isRunning}
                        className="flex items-center gap-1 rounded px-2 py-0.5 bg-primary/80 hover:bg-primary text-white transition-colors disabled:opacity-60">
                        {isRunning ? <Loader2 className="h-3 w-3 animate-spin" /> : <Play className="h-3 w-3" />}
                        <span className="text-[10px]">{isRunning ? 'Running…' : 'Run'}</span>
                      </button>
                    )}
                  </div>
                </div>
                <pre className="p-3 overflow-x-auto text-zinc-200 font-mono leading-relaxed text-[11px] whitespace-pre-wrap break-words">
                  {part.value}
                </pre>
              </div>
            );
          }
          return null;
        })}
      </div>
    </div>
  );
}
