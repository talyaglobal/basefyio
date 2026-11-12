'use client';

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { usePathname } from 'next/navigation';
import { toast } from 'sonner';
import { api } from '@/lib/api';
import {
  BASEFYIO_AI_SEND_EVENT,
  buildSqlRunErrorPrompt,
  type BasefyioAiSendDetail,
} from '@/lib/basefyio-ai-events';
import { dispatchbasefyioNotification } from '@/lib/notifications-context';
import { useActiveTeam } from '@/app/dashboard/layout';
import { cn } from '@/lib/utils';
import {
  looksReadOnly,
  streamAiChat,
  type AiMode,
  type AiQueryEvent,
} from '@/lib/ai-assistant';
import { confirmDialog } from '@/components/ui/confirm-dialog';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Markdown } from '@/components/ai/markdown';
import { CodeBlock, ProposalCard, QueryResults, resultLabel, type ProposalState } from '@/components/ai/ai-blocks';
import { AiModelSettings } from '@/components/ai/ai-model-settings';
import {
  Bot,
  ChevronDown,
  ChevronRight,
  ClipboardList,
  Loader2,
  MessageCircle,
  Pencil,
  Play,
  Plus,
  RotateCcw,
  Send,
  Settings2,
  ShieldCheck,
  Sparkles,
  Square,
  X,
  Zap,
} from 'lucide-react';

// ── Types ──────────────────────────────────────────────────────────────────────

interface Message {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  mode?: AiMode;
  /** streaming while the reply arrives; done/stopped/error once it ended. */
  status?: 'streaming' | 'done' | 'stopped' | 'error';
  statusLabel?: string | null;
  /** Agent mode: the answer written from the real query results. */
  followup?: string;
  queries?: AiQueryEvent[];
  proposals?: ProposalState[];
  error?: string | null;
  /** Model that wrote the reply, e.g. "gpt-4o-mini". */
  model?: string | null;
  /**
   * Turns the panel adds itself. 'outcome' records what happened to a
   * proposal (applied, failed, discarded) — not shown as a bubble, but sent to
   * the model as history and used to restore the card after a reload.
   */
  kind?: 'outcome' | 'result' | 'proposal';
  outcomeFor?: string | null;
}

interface ChatSession {
  /** Stable key in the panel. Equals serverId for conversations loaded from the server. */
  id: string;
  serverId: string | null;
  messages: Message[];
}

interface PageContext {
  projectId?: string;
  projectName?: string;
  page?: string;
}

// ── Helpers ────────────────────────────────────────────────────────────────────
function genId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

function getSessionTitle(session: ChatSession): string {
  const first = session.messages.find((m) => m.role === 'user');
  if (!first) return 'New chat';
  return first.content.length > 22 ? first.content.slice(0, 22) + '…' : first.content;
}

/**
 * Read whatever history the browser still holds.
 *
 * The server is where history lives now; this is only read once, to carry a
 * person's existing conversations up the first time they sign in after the
 * change, and the key is cleared afterwards so it cannot drift.
 */
function readLegacySessions(key: string): { messages: { role: string; content: string }[] }[] {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as { messages: { role: string; content: string }[] }[];
    return Array.isArray(parsed) ? parsed.filter((s) => s?.messages?.length) : [];
  } catch {
    return [];
  }
}

function storageGet(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function storageSet(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* private mode */
  }
}

/** The structured parts of a turn, kept with it on the server so a reload shows the same thing. */
function toMeta(m: Message): Record<string, unknown> | undefined {
  const meta: Record<string, unknown> = {};
  if (m.mode) meta.mode = m.mode;
  if (m.status && m.status !== 'done') meta.status = m.status;
  if (m.followup) meta.followup = m.followup;
  if (m.error) meta.error = m.error;
  if (m.model) meta.model = m.model;
  if (m.kind) meta.kind = m.kind;
  if (m.outcomeFor) meta.outcomeFor = m.outcomeFor;
  if (m.queries?.length) {
    meta.queries = m.queries.map((q) => ({
      ...q,
      results: q.results.map((r) => ({ ...r, rows: r.rows.slice(0, 25), truncated: r.truncated || r.rows.length > 25 })),
    }));
  }
  if (m.proposals?.length) {
    meta.proposals = m.proposals.map((p) => ({
      ...p,
      status: p.status === 'approving' ? 'pending' : p.status,
      outcome: p.outcome
        ? { ...p.outcome, statements: p.outcome.statements.map((s) => ({ ...s, rows: s.rows.slice(0, 25) })) }
        : p.outcome,
    }));
  }
  return Object.keys(meta).length ? meta : undefined;
}

function fromServer(m: { id: string; role: string; content: string; meta?: unknown }): Message {
  const meta = (m.meta && typeof m.meta === 'object' ? m.meta : {}) as Partial<Message>;
  return {
    id: m.id,
    role: m.role === 'assistant' ? 'assistant' : 'user',
    content: m.content,
    mode: meta.mode,
    status: meta.status === 'streaming' ? 'stopped' : meta.status ?? 'done',
    followup: meta.followup,
    queries: meta.queries,
    proposals: meta.proposals,
    error: meta.error,
    model: meta.model,
    kind: meta.kind,
    outcomeFor: meta.outcomeFor,
  };
}

/** A proposal's card shows what its outcome turn recorded, after a reload too. */
function linkOutcomes(messages: Message[]): Message[] {
  const outcomes = new Map<string, Message>();
  for (const m of messages) if (m.kind === 'outcome' && m.outcomeFor) outcomes.set(m.outcomeFor, m);
  if (!outcomes.size) return messages;
  return messages.map((m) =>
    m.proposals?.some((p) => p.proposal && outcomes.has(p.proposal.id))
      ? {
          ...m,
          proposals: m.proposals.map((p) => {
            const o = p.proposal ? outcomes.get(p.proposal.id) : undefined;
            if (!o || p.status !== 'pending') return p;
            const recorded = o.proposals?.[0];
            return recorded ? { ...p, status: recorded.status, outcome: recorded.outcome, message: recorded.message } : p;
          }),
        }
      : m,
  );
}

/** What the model is told about a turn: the text plus what really happened. */
function historyContent(m: Message): string {
  if (m.role === 'user') return m.content;
  const parts: string[] = [];
  if (m.content) parts.push(m.content);
  for (const q of m.queries ?? []) {
    parts.push(
      `[basefyio ran this read-only query: ${q.results.map((r) => (r.ok ? resultLabel(r) : `failed — ${r.error}`)).join('; ')}]`,
    );
  }
  for (const p of m.proposals ?? []) {
    const state =
      p.status === 'applied'
        ? 'approved and applied'
        : p.status === 'failed'
          ? 'approved but FAILED'
          : p.status === 'rejected'
            ? 'discarded by the user, not run'
            : p.status === 'invalid'
              ? `rejected by validation (${p.validation.error}), not run`
              : 'waiting for approval, NOT run';
    parts.push(`[Proposed change — ${state}]`);
  }
  if (m.followup) parts.push(m.followup);
  if (m.status === 'stopped') parts.push('[The user stopped this reply.]');
  if (m.status === 'error' && m.error) parts.push(`[Error: ${m.error}]`);
  return parts.join('\n\n').slice(0, 12_000);
}

// ── Mode config ────────────────────────────────────────────────────────────────
const MODES: {
  id: AiMode;
  label: string;
  icon: React.ElementType;
  description: string;
  placeholder: string;
}[] = [
  { id: 'ask', label: 'Ask', icon: MessageCircle, description: 'Quick Q&A', placeholder: 'Ask anything…' },
  { id: 'plan', label: 'Plan', icon: ClipboardList, description: 'Step-by-step planning', placeholder: 'What do you want to plan?' },
  {
    id: 'agent',
    label: 'Agent',
    icon: Zap,
    description: 'Reads on its own, changes after your approval',
    placeholder: 'What should I do or analyze?',
  },
];

function getSuggestions(mode: AiMode, hasProject: boolean): string[] {
  if (mode === 'ask') {
    return hasProject
      ? ['What tables exist in this project?', 'How do I set up RLS?', 'When do I need indexes?']
      : ['What can basefyio do?', 'How do I connect to PostgreSQL?'];
  }
  if (mode === 'plan') {
    return hasProject
      ? ['Draft a migration plan for my schema', 'Plan row level security for my tables']
      : ['Plan a new project schema', 'How should I design auth?'];
  }
  return hasProject
    ? ['Analyze all tables and summarize', 'Find missing indexes']
    : ['Open a project to let the agent work on it'];
}

const PAGE_FROM_PATH: [RegExp, string][] = [
  [/\/sql(\/|$)/, 'sql'],
  [/\/tables(\/|$)/, 'tables'],
  [/\/data(\/|$)/, 'data'],
  [/\/database(\/|$)/, 'database'],
  [/\/auth(\/|$)/, 'auth'],
  [/\/storage(\/|$)/, 'storage'],
  [/\/realtime(\/|$)/, 'realtime'],
  [/\/flows(\/|$)/, 'flows'],
  [/\/embeddings(\/|$)/, 'embeddings'],
  [/\/api-explorer(\/|$)/, 'api-explorer'],
  [/\/connect(\/|$)/, 'connect'],
  [/\/logs(\/|$)/, 'logs'],
  [/\/settings(\/|$)/, 'settings'],
];

// ── Main component ────────────────────────────────────────────────────────────
export function AiAssistant() {
  const pathname = usePathname();
  const { activeTeamId, profile } = useActiveTeam();

  // ── Visibility ──────────────────────────────────────────────────────────
  const [open, setOpen] = useState<boolean>(() => {
    if (typeof window === 'undefined') return true;
    return (storageGet('basefyio_ai_open') ?? 'true') === 'true';
  });
  const openRef = useRef(open);
  openRef.current = open;

  // ── Resizable width ──────────────────────────────────────────────────────
  const [sidebarWidth, setSidebarWidth] = useState<number>(() => {
    if (typeof window === 'undefined') return 380;
    return parseInt(storageGet('basefyio_ai_width') || '380', 10);
  });
  const isDragging = useRef(false);
  const dragStartX = useRef(0);
  const dragStartWidth = useRef(380);
  const widthRef = useRef(sidebarWidth);
  widthRef.current = sidebarWidth;

  const onDragStart = useCallback((e: React.MouseEvent) => {
    isDragging.current = true;
    dragStartX.current = e.clientX;
    dragStartWidth.current = widthRef.current;
    e.preventDefault();
  }, []);

  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      if (!isDragging.current) return;
      const delta = dragStartX.current - e.clientX;
      setSidebarWidth(Math.min(Math.max(dragStartWidth.current + delta, 280), 760));
    };
    const onUp = () => {
      if (isDragging.current) {
        isDragging.current = false;
        storageSet('basefyio_ai_width', widthRef.current.toString());
      }
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
    return () => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
    };
  }, []);

  // ── Storage keys: per user + per team ────────────────────────────────────
  const userTeamKey = profile?.id && activeTeamId ? `${profile.id}_${activeTeamId}` : null;
  const legacyKey = userTeamKey ? `basefyio_ai_sessions_${userTeamKey}` : null;
  const activeKey = userTeamKey ? `basefyio_ai_active_${userTeamKey}` : null;
  const loadedKeyRef = useRef<string | null>(null);

  // ── Sessions ─────────────────────────────────────────────────────────────
  const [sessions, setSessions] = useState<ChatSession[]>(() => [{ id: genId(), serverId: null, messages: [] }]);
  const [activeSessionId, setActiveSessionId] = useState<string>(() => sessions[0].id);
  const sessionsRef = useRef(sessions);
  sessionsRef.current = sessions;
  const activeSessionIdRef = useRef(activeSessionId);
  activeSessionIdRef.current = activeSessionId;
  /** Turns already on the server, per session key, so a sync appends only what is new. */
  const syncedCountRef = useRef<Record<string, number>>({});
  /** A session is created on the server once, however many syncs ask for it. */
  const creatingRef = useRef<Record<string, Promise<string | null>>>({});

  // Load this person's history from the server. It is keyed to them by their
  // token, so another account on the same machine sees its own conversations.
  useEffect(() => {
    if (!userTeamKey || !activeTeamId || !legacyKey) return;
    if (loadedKeyRef.current === userTeamKey) return;
    loadedKeyRef.current = userTeamKey;

    let cancelled = false;
    (async () => {
      try {
        let summaries = await api.aiChat.listSessions(activeTeamId);
        if (summaries.length === 0) {
          const legacy = readLegacySessions(legacyKey);
          for (const s of legacy.slice(-10)) {
            const created = await api.aiChat.createSession(activeTeamId);
            await api.aiChat.appendMessages(
              created.id,
              s.messages.map((m) => ({ role: m.role, content: m.content })),
            );
          }
          if (legacy.length) summaries = await api.aiChat.listSessions(activeTeamId);
        }
        try {
          localStorage.removeItem(legacyKey);
        } catch {}

        if (cancelled || !summaries.length) return;
        // Oldest first, so the newest conversation sits at the end of the tab strip.
        const ordered = [...summaries].reverse();
        const full = await Promise.all(ordered.map((s) => api.aiChat.getSession(s.id).catch(() => null)));
        if (cancelled) return;
        const loaded: ChatSession[] = full
          .filter((s): s is NonNullable<typeof s> => !!s)
          .map((s) => ({ id: s.id, serverId: s.id, messages: linkOutcomes(s.messages.map(fromServer)) }));
        if (!loaded.length) return;
        for (const s of loaded) syncedCountRef.current[s.id] = s.messages.length;
        // Keep a conversation started while history was loading.
        setSessions((prev) => [...loaded, ...prev.filter((p) => p.messages.length > 0 && !p.serverId)]);
        const remembered = activeKey ? storageGet(activeKey) : null;
        setActiveSessionId((current) => {
          const local = sessionsRef.current.find((s) => s.id === current);
          if (local && local.messages.length > 0) return current;
          return loaded.some((s) => s.id === remembered) ? (remembered as string) : loaded[loaded.length - 1].id;
        });
      } catch {
        // History is a convenience: if it cannot be fetched the assistant still answers.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [userTeamKey, activeTeamId, legacyKey, activeKey]);

  useEffect(() => {
    const s = sessions.find((x) => x.id === activeSessionId);
    if (activeKey && s?.serverId) storageSet(activeKey, s.serverId);
  }, [activeSessionId, sessions, activeKey]);

  const ensureServerSession = useCallback(
    (key: string): Promise<string | null> => {
      const existing = sessionsRef.current.find((s) => s.id === key);
      if (existing?.serverId) return Promise.resolve(existing.serverId);
      if (!activeTeamId) return Promise.resolve(null);
      if (!creatingRef.current[key]) {
        creatingRef.current[key] = api.aiChat
          .createSession(activeTeamId, pageContextRef.current.projectId)
          .then((created) => {
            setSessions((prev) => prev.map((s) => (s.id === key ? { ...s, serverId: created.id } : s)));
            return created.id;
          })
          .catch(() => {
            delete creatingRef.current[key];
            return null;
          });
      }
      return creatingRef.current[key];
    },
    // pageContextRef is a ref; activeTeamId is the only input that matters.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [activeTeamId],
  );

  // Push finished turns up. A reply still streaming is held back until it ends,
  // so the server never stores half an answer.
  useEffect(() => {
    if (!activeTeamId) return;
    const timer = setTimeout(() => {
      for (const s of sessions) {
        const firstOpen = s.messages.findIndex((m) => m.status === 'streaming');
        const stable = firstOpen === -1 ? s.messages : s.messages.slice(0, firstOpen);
        const already = syncedCountRef.current[s.id] ?? 0;
        if (stable.length <= already) continue;
        const pending = stable.slice(already);
        syncedCountRef.current[s.id] = stable.length;
        void ensureServerSession(s.id).then((serverId) => {
          if (!serverId) {
            syncedCountRef.current[s.id] = already;
            return;
          }
          return api.aiChat
            .appendMessages(
              serverId,
              pending.map((m) => ({ role: m.role, content: m.content || historyContent(m) || '(empty)', meta: toMeta(m) })),
            )
            .catch(() => {
              // The next change retries from where this one left off.
              syncedCountRef.current[s.id] = already;
            });
        });
      }
    }, 600);
    return () => clearTimeout(timer);
  }, [sessions, activeTeamId, ensureServerSession]);

  const activeSession = sessions.find((s) => s.id === activeSessionId) ?? sessions[0];
  const messages = activeSession?.messages ?? [];
  const visibleMessages = useMemo(() => messages.filter((m) => m.kind !== 'outcome'), [messages]);

  const updateSession = useCallback((sessionId: string, updater: (prev: Message[]) => Message[]) => {
    setSessions((prev) => prev.map((s) => (s.id === sessionId ? { ...s, messages: updater(s.messages) } : s)));
  }, []);

  const newChat = useCallback(() => {
    const id = genId();
    setSessions((prev) => [...prev, { id, serverId: null, messages: [] }]);
    setActiveSessionId(id);
  }, []);

  const closeSession = useCallback(
    async (id: string, e: React.MouseEvent) => {
      e.stopPropagation();
      const session = sessionsRef.current.find((s) => s.id === id);
      if (session && session.messages.length > 0) {
        const ok = await confirmDialog({
          title: 'Delete this conversation?',
          description: 'It is removed from your assistant history and cannot be restored.',
          confirmText: 'Delete',
          destructive: true,
        });
        if (!ok) return;
      }
      if (session?.serverId) api.aiChat.deleteSession(session.serverId).catch(() => {});
      delete syncedCountRef.current[id];
      const remaining = sessionsRef.current.filter((s) => s.id !== id);
      const next = remaining.length ? remaining : [{ id: genId(), serverId: null, messages: [] }];
      setSessions(next);
      if (activeSessionIdRef.current === id || !remaining.length) setActiveSessionId(next[next.length - 1].id);
    },
    [],
  );

  // ── Mode ─────────────────────────────────────────────────────────────────
  const [mode, setMode] = useState<AiMode>(() => {
    if (typeof window === 'undefined') return 'ask';
    const saved = storageGet('basefyio_ai_mode');
    return saved === 'plan' || saved === 'agent' ? saved : 'ask';
  });
  const modeRef = useRef(mode);
  modeRef.current = mode;
  const [modeOpen, setModeOpen] = useState(false);
  const modeMenuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (modeMenuRef.current && !modeMenuRef.current.contains(e.target as Node)) setModeOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  const changeMode = useCallback((m: AiMode) => {
    setMode(m);
    storageSet('basefyio_ai_mode', m);
    setModeOpen(false);
  }, []);

  // ── Page context ───────────────────────────────────────────────────────────
  const [pageContext, setPageContext] = useState<PageContext>({});
  const pageContextRef = useRef(pageContext);
  pageContextRef.current = pageContext;
  const projectNames = useRef<Record<string, string>>({});
  const teamProjectsRef = useRef<{ id: string; name: string }[] | null>(null);

  useEffect(() => {
    if (!pathname) return;
    const projectMatch = pathname.match(/\/dashboard\/projects\/([^/]+)/);
    const projectId = projectMatch?.[1];
    if (projectId && projectId !== 'undefined') {
      const page = PAGE_FROM_PATH.find(([re]) => re.test(pathname))?.[1] ?? 'project-detail';
      setPageContext((p) =>
        p.projectId === projectId && p.page === page ? p : { projectId, page, projectName: projectNames.current[projectId] },
      );
      if (!projectNames.current[projectId]) {
        api.projects
          .get(projectId)
          .then((project) => {
            if (!project?.name) return;
            projectNames.current[projectId] = project.name;
            setPageContext((p) => (p.projectId === projectId ? { ...p, projectName: project.name } : p));
          })
          .catch(() => {});
      }
    } else {
      setPageContext({ page: pathname === '/dashboard/projects' ? 'projects' : 'dashboard' });
    }
  }, [pathname]);

  /** Outside a project, a message that names one of the team's projects is about that project. */
  const projectForMessage = useCallback(
    async (text: string): Promise<{ id?: string; name?: string }> => {
      const ctx = pageContextRef.current;
      if (ctx.projectId) return { id: ctx.projectId, name: ctx.projectName };
      if (!activeTeamId) return {};
      try {
        if (!teamProjectsRef.current) {
          const list = await api.projects.list(activeTeamId);
          teamProjectsRef.current = list.map((p) => ({ id: p.id, name: p.name }));
        }
        const lower = text.toLowerCase();
        const found = teamProjectsRef.current
          .filter((p) => p.name.trim().length >= 2 && lower.includes(p.name.toLowerCase()))
          .sort((a, b) => b.name.length - a.name.length)[0];
        return found ? { id: found.id, name: found.name } : {};
      } catch {
        return {};
      }
    },
    [activeTeamId],
  );

  // ── Sending ──────────────────────────────────────────────────────────────
  const [streaming, setStreaming] = useState(false);
  const streamingRef = useRef(false);
  const abortRef = useRef<AbortController | null>(null);
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [input, setInput] = useState<string>(() => {
    if (typeof window === 'undefined') return '';
    try {
      return sessionStorage.getItem('basefyio_ai_draft') ?? '';
    } catch {
      return '';
    }
  });
  useEffect(() => {
    try {
      sessionStorage.setItem('basefyio_ai_draft', input);
    } catch {}
  }, [input]);

  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const stickToBottom = useRef(true);

  const onScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    stickToBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
  }, []);

  useEffect(() => {
    const el = scrollRef.current;
    if (open && el && stickToBottom.current) el.scrollTop = el.scrollHeight;
  }, [messages, open]);

  useEffect(() => {
    if (open) setTimeout(() => inputRef.current?.focus(), 150);
  }, [open, activeSessionId]);

  const sendMessage = useCallback(
    async (text: string, opts?: { mode?: AiMode }) => {
      const trimmed = text.trim();
      if (!trimmed || streamingRef.current) return;
      const sendMode = opts?.mode ?? modeRef.current;
      const sessionId = activeSessionIdRef.current;
      const session = sessionsRef.current.find((s) => s.id === sessionId);
      const history = (session?.messages ?? [])
        .filter((m) => m.status !== 'streaming')
        .slice(-16)
        .map((m) => ({ role: m.role, content: historyContent(m) }))
        .filter((m) => m.content.trim());

      const replyId = genId();
      updateSession(sessionId, (p) => [
        ...p,
        { id: genId(), role: 'user', content: trimmed, mode: sendMode, status: 'done' },
        { id: replyId, role: 'assistant', content: '', mode: sendMode, status: 'streaming', statusLabel: 'Reading your project…' },
      ]);
      setInput('');
      stickToBottom.current = true;

      const update = (fn: (m: Message) => Message) =>
        updateSession(sessionId, (p) => p.map((m) => (m.id === replyId ? fn(m) : m)));

      const controller = new AbortController();
      abortRef.current = controller;
      streamingRef.current = true;
      setStreaming(true);
      try {
        const project = await projectForMessage(trimmed);
        await streamAiChat(
          {
            message: trimmed,
            history,
            context: { projectId: project.id, projectName: project.name, page: pageContextRef.current.page, mode: sendMode },
          },
          (e) => {
            switch (e.event) {
              case 'meta':
                update((m) => ({ ...m, model: `${e.data.model}${e.data.source === 'project' ? ' · project key' : ''}` }));
                break;
              case 'status':
                update((m) => ({ ...m, statusLabel: e.data.label }));
                break;
              case 'delta':
                update((m) =>
                  e.data.part === 'reply'
                    ? { ...m, content: m.content + e.data.text }
                    : { ...m, followup: (m.followup ?? '') + e.data.text },
                );
                break;
              case 'query':
                update((m) => ({ ...m, queries: [...(m.queries ?? []), e.data] }));
                break;
              case 'proposal':
                update((m) => ({
                  ...m,
                  proposals: [...(m.proposals ?? []), { ...e.data, status: e.data.proposal ? 'pending' : 'invalid' }],
                }));
                break;
              case 'done':
                update((m) => ({ ...m, status: e.data.stopped ? 'stopped' : 'done', statusLabel: null }));
                break;
              case 'error':
                update((m) => ({ ...m, status: 'error', error: e.data.message, statusLabel: null }));
                break;
            }
          },
          controller.signal,
        );
        update((m) => (m.status === 'streaming' ? { ...m, status: 'done', statusLabel: null } : m));
      } catch (err: any) {
        if (controller.signal.aborted) {
          update((m) => ({ ...m, status: 'stopped', statusLabel: null }));
        } else {
          update((m) => ({ ...m, status: 'error', statusLabel: null, error: err?.message ?? String(err) }));
        }
      } finally {
        abortRef.current = null;
        streamingRef.current = false;
        setStreaming(false);
        if (!openRef.current) {
          dispatchbasefyioNotification({ type: 'ai', title: 'AI replied', message: 'A new reply is ready in the assistant.' });
        }
      }
    },
    [projectForMessage, updateSession],
  );

  const sendMessageRef = useRef(sendMessage);
  sendMessageRef.current = sendMessage;

  const stop = useCallback(() => abortRef.current?.abort(), []);

  // Messages sent from elsewhere in the dashboard (SQL editor errors, imports).
  useEffect(() => {
    const onKbAiSend = (e: Event) => {
      const detail = (e as CustomEvent<BasefyioAiSendDetail>).detail;
      const msg = detail?.message?.trim();
      if (!msg) return;
      setOpen(true);
      storageSet('basefyio_ai_open', 'true');
      const m = detail.mode;
      if (m === 'ask' || m === 'plan' || m === 'agent') changeMode(m);
      const run = () => void sendMessageRef.current(msg, m ? { mode: m } : undefined);
      if (typeof requestAnimationFrame === 'function') requestAnimationFrame(() => setTimeout(run, 0));
      else setTimeout(run, 0);
    };
    window.addEventListener(BASEFYIO_AI_SEND_EVENT, onKbAiSend as EventListener);
    return () => window.removeEventListener(BASEFYIO_AI_SEND_EVENT, onKbAiSend as EventListener);
  }, [changeMode]);

  // ── SQL blocks: run reads, review changes ───────────────────────────────────
  const runBlock = useCallback(
    async (sql: string) => {
      const projectId = pageContextRef.current.projectId;
      if (!projectId) {
        toast.error('Open a project to run SQL');
        return;
      }
      const sessionId = activeSessionIdRef.current;
      setBusyAction(sql);
      try {
        if (looksReadOnly(sql)) {
          try {
            const { results } = await api.ai.runSql(projectId, sql);
            updateSession(sessionId, (p) => [
              ...p,
              {
                id: genId(),
                role: 'assistant',
                kind: 'result',
                status: 'done',
                content: `Ran the query read-only: ${results.map((r) => (r.ok ? resultLabel(r) : 'failed')).join(', ')}.`,
                queries: [{ index: 0, sql, results }],
              },
            ]);
            return;
          } catch (err: any) {
            if (err?.status !== 422) throw err;
          }
        }
        const event = await api.ai.propose(projectId, sql);
        updateSession(sessionId, (p) => [
          ...p,
          {
            id: genId(),
            role: 'assistant',
            kind: 'proposal',
            status: 'done',
            content: event.proposal
              ? 'This SQL changes your database. Review it below; it runs only if you approve.'
              : 'This SQL was checked against your database and failed, so it cannot be run as written.',
            proposals: [{ ...event, status: event.proposal ? 'pending' : 'invalid' }],
          },
        ]);
      } catch (err: any) {
        const message = (err?.message ?? String(err)).trim();
        toast.error(message, {
          duration: 20_000,
          action: { label: 'Ask to fix', onClick: () => void sendMessageRef.current(buildSqlRunErrorPrompt(sql, message), { mode: 'ask' }) },
        });
      } finally {
        setBusyAction(null);
      }
    },
    [updateSession],
  );

  const setProposal = useCallback(
    (sessionId: string, messageId: string, proposalId: string, patch: Partial<ProposalState>) => {
      updateSession(sessionId, (p) =>
        p.map((m) =>
          m.id === messageId
            ? { ...m, proposals: m.proposals?.map((x) => (x.proposal?.id === proposalId ? { ...x, ...patch } : x)) }
            : m,
        ),
      );
    },
    [updateSession],
  );

  const approve = useCallback(
    async (messageId: string, proposal: ProposalState) => {
      if (!proposal.proposal) return;
      const sessionId = activeSessionIdRef.current;
      const id = proposal.proposal.id;
      const warnings = proposal.statements.filter((s) => s.destructive);
      if (warnings.length) {
        const ok = await confirmDialog({
          title: 'Run a destructive change?',
          description: (
            <span className="block space-y-1">
              {warnings.map((w, i) => (
                <span key={i} className="block">
                  <strong>{w.command}</strong>: {w.warning}
                </span>
              ))}
              <span className="block pt-1">This cannot be undone from here. Make sure you have a backup if the data matters.</span>
            </span>
          ),
          confirmText: 'Run it',
          destructive: true,
        });
        if (!ok) return;
      }
      setBusyAction(id);
      setProposal(sessionId, messageId, id, { status: 'approving' });
      try {
        const outcome = await api.ai.approve(id);
        const status = outcome.failedIndex === null ? 'applied' : 'failed';
        setProposal(sessionId, messageId, id, { status, outcome });
        updateSession(sessionId, (p) => [
          ...p,
          {
            id: genId(),
            role: 'assistant',
            kind: 'outcome',
            outcomeFor: id,
            status: 'done',
            content: `[Result of the approved change, checked in the database]\n${outcome.summary}`,
            proposals: [{ ...proposal, status, outcome }],
          },
        ]);
        if (status === 'applied' && outcome.ok) toast.success('Change applied and verified');
        else if (status === 'applied') toast.warning('Change ran, but a check did not match — see details');
        else toast.error('The change failed; nothing was kept');
      } catch (err: any) {
        if (err?.status === 410 || err?.status === 404) {
          setProposal(sessionId, messageId, id, { status: 'expired', message: err.message });
        } else {
          setProposal(sessionId, messageId, id, { status: 'pending' });
          toast.error(err?.message ?? 'Could not run the change');
        }
      } finally {
        setBusyAction(null);
      }
    },
    [setProposal, updateSession],
  );

  const reject = useCallback(
    async (messageId: string, proposal: ProposalState) => {
      if (!proposal.proposal) return;
      const sessionId = activeSessionIdRef.current;
      const id = proposal.proposal.id;
      setBusyAction(id);
      try {
        await api.ai.reject(id).catch((err) => {
          if (err?.status !== 410 && err?.status !== 404) throw err;
        });
        setProposal(sessionId, messageId, id, { status: 'rejected' });
        updateSession(sessionId, (p) => [
          ...p,
          {
            id: genId(),
            role: 'assistant',
            kind: 'outcome',
            outcomeFor: id,
            status: 'done',
            content: '[The user discarded the proposed change. Nothing was run.]',
            proposals: [{ ...proposal, status: 'rejected' }],
          },
        ]);
      } catch (err: any) {
        toast.error(err?.message ?? 'Could not discard the change');
      } finally {
        setBusyAction(null);
      }
    },
    [setProposal, updateSession],
  );

  const handToAgent = useCallback(() => {
    changeMode('agent');
    void sendMessage(
      'Carry out the plan above step by step in this project. Run read-only checks first, then propose each change for my approval.',
      { mode: 'agent' },
    );
  }, [changeMode, sendMessage]);

  // ── Settings dialog ────────────────────────────────────────────────────────
  const [settingsOpen, setSettingsOpen] = useState(false);

  const currentMode = MODES.find((m) => m.id === mode)!;
  const hasProject = !!pageContext.projectId;
  const suggestions = getSuggestions(mode, hasProject);
  const lastAssistantId = [...visibleMessages].reverse().find((m) => m.role === 'assistant')?.id;

  const toggle = () => {
    setOpen((o) => {
      const n = !o;
      storageSet('basefyio_ai_open', n ? 'true' : 'false');
      return n;
    });
  };

  // ── Closed state ──────────────────────────────────────────────────────────
  if (!open) {
    return (
      <div className="w-10 shrink-0 border-l bg-card flex flex-col items-center py-5">
        <button
          onClick={toggle}
          title="Open AI assistant"
          className="flex flex-col items-center gap-2 rounded-lg p-2 hover:bg-accent transition-colors group"
        >
          <Sparkles className={cn('h-4 w-4 text-primary group-hover:scale-110 transition-transform', streaming && 'animate-pulse')} />
          <span
            className="text-[9px] font-semibold tracking-widest text-muted-foreground uppercase"
            style={{ writingMode: 'vertical-rl', transform: 'rotate(180deg)' }}
          >
            AI
          </span>
        </button>
      </div>
    );
  }

  // ── Open state ────────────────────────────────────────────────────────────
  return (
    <div className="flex shrink-0" style={{ width: sidebarWidth }}>
      <div
        onMouseDown={onDragStart}
        className="w-1 shrink-0 cursor-col-resize hover:bg-primary/40 transition-colors group relative"
        title="Drag to resize width"
      >
        <div className="absolute inset-y-0 left-0 w-4 -translate-x-1.5" />
      </div>

      <div className="flex-1 border-l bg-card flex flex-col overflow-hidden min-w-0">
        {/* Header */}
        <div className="flex items-center gap-2.5 border-b px-3 py-2.5 shrink-0">
          <div className="flex h-6 w-6 items-center justify-center rounded-md bg-gradient-to-br from-blue-500 to-blue-700">
            <Bot className="h-3.5 w-3.5 text-white" />
          </div>
          <div className="flex-1 min-w-0">
            <p className="text-xs font-semibold leading-tight truncate">
              basefyio AI
              {pageContext.projectName && (
                <span className="ml-1.5 font-normal text-muted-foreground">· {pageContext.projectName}</span>
              )}
            </p>
          </div>
          <div className="flex items-center gap-0.5 shrink-0">
            {hasProject && (
              <button
                onClick={() => setSettingsOpen(true)}
                title="Model and API key for this project"
                className="rounded p-1 hover:bg-accent transition-colors text-muted-foreground"
              >
                <Settings2 className="h-3.5 w-3.5" />
              </button>
            )}
            <button onClick={newChat} title="New chat" className="rounded p-1 hover:bg-accent transition-colors text-muted-foreground">
              <Plus className="h-3.5 w-3.5" />
            </button>
            <button onClick={toggle} title="Collapse panel" className="rounded p-1 hover:bg-accent transition-colors text-muted-foreground">
              <ChevronRight className="h-3.5 w-3.5" />
            </button>
          </div>
        </div>

        {/* Session tabs */}
        <div
          className="flex items-center gap-0.5 border-b px-1 py-1 overflow-x-auto scrollbar-none shrink-0 bg-muted/40"
          style={{ scrollbarWidth: 'none' }}
        >
          {sessions.map((session) => {
            const active = session.id === activeSessionId;
            return (
              <div
                key={session.id}
                role="tab"
                aria-selected={active}
                tabIndex={0}
                onClick={() => setActiveSessionId(session.id)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') setActiveSessionId(session.id);
                }}
                className={cn(
                  'group flex cursor-pointer items-center gap-1 rounded px-2 py-1 text-[11px] font-medium whitespace-nowrap transition-colors shrink-0',
                  active ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground hover:bg-background/60 hover:text-foreground',
                )}
              >
                <span className="max-w-[100px] truncate">{getSessionTitle(session)}</span>
                <button
                  type="button"
                  title="Delete conversation"
                  onClick={(e) => void closeSession(session.id, e)}
                  className={cn(
                    'ml-0.5 rounded p-0.5 transition-colors',
                    active ? 'hover:bg-muted text-muted-foreground' : 'text-transparent group-hover:text-muted-foreground hover:bg-muted',
                  )}
                >
                  <X className="h-2.5 w-2.5" />
                </button>
              </div>
            );
          })}
          <button onClick={newChat} title="New chat" className="ml-0.5 shrink-0 rounded p-1 hover:bg-background/60 transition-colors text-muted-foreground">
            <Plus className="h-3 w-3" />
          </button>
        </div>

        {/* Messages */}
        <div ref={scrollRef} onScroll={onScroll} className="flex-1 overflow-y-auto p-3 space-y-3 min-h-0">
          {visibleMessages.length === 0 ? (
            <div className="flex flex-col items-center justify-center h-full gap-4 px-2">
              <div className="flex h-11 w-11 items-center justify-center rounded-2xl bg-gradient-to-br from-blue-500 to-blue-700 shadow">
                <currentMode.icon className="h-5 w-5 text-white" />
              </div>
              <div className="text-center">
                <p className="text-sm font-semibold">{currentMode.label} mode</p>
                <p className="text-xs text-muted-foreground mt-0.5">
                  {hasProject && pageContext.projectName
                    ? `"${pageContext.projectName}" · ${currentMode.description}`
                    : currentMode.description}
                </p>
              </div>
              {!hasProject && (
                <div className="w-full rounded-lg border border-blue-200 bg-blue-50 dark:bg-blue-950/30 dark:border-blue-800 px-3 py-2 text-[11px] text-blue-700 dark:text-blue-300">
                  Open a project, or mention one by name, and the assistant reads its schema.
                </div>
              )}
              <div className="w-full space-y-1.5">
                {suggestions.map((s) => (
                  <button
                    key={s}
                    onClick={() => void sendMessage(s)}
                    disabled={streaming || (mode === 'agent' && !hasProject)}
                    className="w-full rounded-lg border bg-background px-3 py-2 text-left text-xs hover:bg-accent transition-colors text-foreground/80 hover:text-foreground disabled:opacity-60"
                  >
                    {s}
                  </button>
                ))}
              </div>
            </div>
          ) : (
            visibleMessages.map((msg) =>
              msg.role === 'user' ? (
                <UserBubble key={msg.id} message={msg} onResend={(t) => void sendMessage(t)} disabled={streaming} />
              ) : (
                <AssistantMessage
                  key={msg.id}
                  message={msg}
                  canRunSql={hasProject && msg.mode !== 'agent' && msg.kind !== 'proposal'}
                  busyAction={busyAction}
                  streaming={streaming}
                  isLast={msg.id === lastAssistantId}
                  onRunSql={(sql) => void runBlock(sql)}
                  onApprove={(p) => void approve(msg.id, p)}
                  onReject={(p) => void reject(msg.id, p)}
                  onHandToAgent={hasProject ? handToAgent : undefined}
                  onRetry={() => {
                    const idx = messages.findIndex((m) => m.id === msg.id);
                    const prevUser = [...messages.slice(0, idx)].reverse().find((m) => m.role === 'user');
                    if (prevUser) void sendMessage(prevUser.content, { mode: msg.mode });
                  }}
                />
              ),
            )
          )}
        </div>

        {/* Input area */}
        <div className="border-t p-2.5 shrink-0 space-y-2">
          <div className="rounded-xl border bg-background focus-within:ring-1 focus-within:ring-primary/40">
            <textarea
              ref={inputRef}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  if (!streaming) void sendMessage(input);
                }
              }}
              placeholder={currentMode.placeholder}
              rows={2}
              className="w-full resize-none bg-transparent px-3 pt-2.5 pb-1 text-sm outline-none placeholder:text-muted-foreground max-h-36"
              style={{ fieldSizing: 'content' } as React.CSSProperties}
            />

            <div className="flex items-center justify-between px-2 pb-2">
              <div ref={modeMenuRef} className="relative">
                <button
                  onClick={() => setModeOpen((o) => !o)}
                  className={cn(
                    'flex items-center gap-1.5 rounded-md border px-2 py-1 text-[11px] font-medium transition-colors hover:bg-accent',
                    mode === 'ask'
                      ? 'border-blue-200 text-blue-600 bg-blue-50 dark:bg-blue-950/30 dark:border-blue-800 dark:text-blue-400'
                      : mode === 'plan'
                        ? 'border-violet-200 text-violet-600 bg-violet-50 dark:bg-violet-950/30 dark:border-violet-800 dark:text-violet-400'
                        : 'border-amber-200 text-amber-600 bg-amber-50 dark:bg-amber-950/30 dark:border-amber-800 dark:text-amber-400',
                  )}
                >
                  <currentMode.icon className="h-3 w-3" />
                  <span>{currentMode.label}</span>
                  <ChevronDown className="h-2.5 w-2.5 opacity-60" />
                </button>

                {modeOpen && (
                  <div className="absolute bottom-full left-0 mb-1.5 w-60 rounded-xl border bg-popover shadow-lg overflow-hidden z-50">
                    {MODES.map((m) => {
                      const Icon = m.icon;
                      const active = mode === m.id;
                      return (
                        <button
                          key={m.id}
                          onClick={() => changeMode(m.id)}
                          className={cn('flex w-full items-start gap-3 px-3 py-2.5 text-left transition-colors hover:bg-accent', active && 'bg-accent')}
                        >
                          <Icon
                            className={cn(
                              'h-4 w-4 mt-0.5 shrink-0',
                              m.id === 'ask' ? 'text-blue-500' : m.id === 'plan' ? 'text-violet-500' : 'text-amber-500',
                            )}
                          />
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

              <div className="flex items-center gap-1">
                {visibleMessages.length > 0 && !streaming && (
                  <button onClick={newChat} title="Start a new chat" className="rounded-md p-1.5 hover:bg-accent transition-colors text-muted-foreground">
                    <RotateCcw className="h-3.5 w-3.5" />
                  </button>
                )}
                {streaming ? (
                  <button
                    onClick={stop}
                    title="Stop"
                    className="flex h-7 items-center gap-1 rounded-lg bg-foreground px-2 text-background hover:opacity-90 transition-opacity"
                  >
                    <Square className="h-3 w-3 fill-current" />
                    <span className="text-[11px] font-medium">Stop</span>
                  </button>
                ) : (
                  <button
                    onClick={() => void sendMessage(input)}
                    disabled={!input.trim()}
                    title="Send"
                    className="flex h-7 w-7 items-center justify-center rounded-lg bg-primary text-white disabled:opacity-40 hover:opacity-90 transition-opacity"
                  >
                    <Send className="h-3.5 w-3.5" />
                  </button>
                )}
              </div>
            </div>
          </div>

          {mode === 'agent' && hasProject && (
            <p className="flex items-center justify-center gap-1 text-[10px] text-center text-amber-700/80 dark:text-amber-400/70">
              <ShieldCheck className="h-3 w-3" />
              Agent runs read-only queries itself; every change waits for your approval.
            </p>
          )}
        </div>
      </div>

      {pageContext.projectId && (
        <Dialog open={settingsOpen} onOpenChange={setSettingsOpen}>
          <DialogContent className="max-w-lg">
            <DialogHeader>
              <DialogTitle>Assistant model for this project</DialogTitle>
              <DialogDescription>
                Use your own OpenAI, Google Gemini or Anthropic Claude key for conversations about this project.
              </DialogDescription>
            </DialogHeader>
            <AiModelSettings projectId={pageContext.projectId} bare />
          </DialogContent>
        </Dialog>
      )}
    </div>
  );
}

// ── User bubble ────────────────────────────────────────────────────────────────
function UserBubble({
  message,
  onResend,
  disabled,
}: {
  message: Message;
  onResend: (text: string) => void;
  disabled: boolean;
}) {
  const [expanded, setExpanded] = useState(false);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(message.content);
  const isLong = message.content.length > 160 || message.content.split('\n').length > 3;

  if (editing) {
    return (
      <div className="w-full rounded-xl border border-border/60 bg-card px-3.5 py-2.5 shadow-sm space-y-2">
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
            disabled={disabled}
            onClick={() => {
              const next = draft.trim();
              if (!next) return;
              onResend(next);
              setEditing(false);
            }}
            className="inline-flex items-center gap-1 rounded bg-primary px-2 py-1 text-[10px] font-medium text-white hover:opacity-90 disabled:opacity-50"
          >
            <Send className="h-3 w-3" />
            Send again
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="group w-full rounded-xl border border-border/60 bg-card px-3.5 py-2.5 shadow-sm">
      <p className={cn('text-xs text-foreground leading-relaxed whitespace-pre-wrap break-words', isLong && !expanded && 'line-clamp-3')}>
        {message.content}
      </p>
      <div className="mt-1.5 flex items-center gap-2">
        {isLong && (
          <button type="button" onClick={() => setExpanded((v) => !v)} className="text-[10px] font-medium text-primary hover:underline">
            {expanded ? 'Show less' : 'Show full'}
          </button>
        )}
        <button
          type="button"
          onClick={() => {
            setDraft(message.content);
            setEditing(true);
          }}
          className="inline-flex items-center gap-1 text-[10px] font-medium text-muted-foreground opacity-0 group-hover:opacity-100 hover:text-foreground transition-opacity"
        >
          <Pencil className="h-3 w-3" />
          Edit & resend
        </button>
      </div>
    </div>
  );
}

// ── Assistant message ─────────────────────────────────────────────────────────
const MODE_BADGE: Record<AiMode, string> = {
  ask: 'bg-blue-100 text-blue-600 dark:bg-blue-900/40 dark:text-blue-400',
  plan: 'bg-violet-100 text-violet-600 dark:bg-violet-900/40 dark:text-violet-400',
  agent: 'bg-amber-100 text-amber-600 dark:bg-amber-900/40 dark:text-amber-400',
};

function AssistantMessage({
  message,
  canRunSql,
  busyAction,
  streaming,
  isLast,
  onRunSql,
  onApprove,
  onReject,
  onHandToAgent,
  onRetry,
}: {
  message: Message;
  canRunSql: boolean;
  busyAction: string | null;
  streaming: boolean;
  isLast: boolean;
  onRunSql: (sql: string) => void;
  onApprove: (p: ProposalState) => void;
  onReject: (p: ProposalState) => void;
  onHandToAgent?: () => void;
  onRetry: () => void;
}) {
  const live = message.status === 'streaming';
  const renderCode = (code: string, lang: string, key: string, closed: boolean) => {
    const isSql = ['sql', 'postgres', 'postgresql', 'pgsql', 'psql'].includes(lang);
    const runnable = isSql && closed && canRunSql && !live && code.trim().length > 0;
    const readOnly = runnable && looksReadOnly(code);
    return (
      <CodeBlock
        key={key}
        code={code}
        lang={lang}
        action={
          runnable ? (
            <button
              type="button"
              onClick={() => onRunSql(code)}
              disabled={busyAction === code || streaming}
              title={readOnly ? 'Run this read-only query' : 'Check this change and ask for approval before it runs'}
              className="flex items-center gap-1 rounded px-2 py-0.5 bg-primary/80 hover:bg-primary text-white transition-colors disabled:opacity-60"
            >
              {busyAction === code ? <Loader2 className="h-3 w-3 animate-spin" /> : readOnly ? <Play className="h-3 w-3" /> : <ShieldCheck className="h-3 w-3" />}
              <span className="text-[10px]">{readOnly ? 'Run' : 'Review & run'}</span>
            </button>
          ) : undefined
        }
      />
    );
  };

  return (
    <div className="flex items-start gap-2">
      <div className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-gradient-to-br from-blue-500 to-blue-700">
        <Bot className="h-3 w-3 text-white" />
      </div>
      <div className="flex-1 min-w-0 space-y-2">
        {(message.mode || message.model) && message.kind !== 'result' && message.kind !== 'proposal' && (
          <div className="flex items-center gap-1.5">
            {message.mode && (
              <span className={cn('text-[9px] font-semibold uppercase tracking-wider px-1.5 py-0.5 rounded', MODE_BADGE[message.mode])}>
                {message.mode}
              </span>
            )}
            {message.model && <span className="text-[9px] text-muted-foreground truncate">{message.model}</span>}
          </div>
        )}

        {(message.content || live) && (
          <div className="rounded-2xl rounded-tl-sm bg-muted px-3 py-2">
            {message.content ? (
              <Markdown text={message.content} renderCode={renderCode} />
            ) : (
              <span className="flex items-center gap-2 text-xs text-muted-foreground">
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                {message.statusLabel ?? 'Preparing reply…'}
              </span>
            )}
          </div>
        )}

        {message.queries?.map((q, i) => <QueryResults key={`q${i}`} sql={q.sql} results={q.results} />)}

        {message.proposals?.map((p, i) => (
          <ProposalCard
            key={p.proposal?.id ?? `p${i}`}
            proposal={p}
            canAct={!busyAction}
            onApprove={() => onApprove(p)}
            onReject={() => onReject(p)}
          />
        ))}

        {message.followup && (
          <div className="rounded-2xl bg-muted px-3 py-2">
            <Markdown text={message.followup} renderCode={renderCode} />
          </div>
        )}

        {live && message.content && (
          <p className="flex items-center gap-1.5 text-[10px] text-muted-foreground">
            <Loader2 className="h-3 w-3 animate-spin" />
            {message.statusLabel ?? 'Writing…'}
          </p>
        )}
        {message.status === 'stopped' && <p className="text-[10px] text-muted-foreground">Stopped.</p>}
        {message.status === 'error' && (
          <div className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-[11px] text-red-700 dark:border-red-900 dark:bg-red-950/30 dark:text-red-400">
            <p className="break-words">{message.error}</p>
            {isLast && (
              <button type="button" onClick={onRetry} disabled={streaming} className="mt-1 font-medium underline underline-offset-2">
                Try again
              </button>
            )}
          </div>
        )}

        {message.mode === 'plan' && message.status === 'done' && isLast && onHandToAgent && message.content.includes('```') && (
          <button
            type="button"
            onClick={onHandToAgent}
            disabled={streaming}
            className="flex items-center gap-1.5 rounded-md border border-amber-300 bg-amber-50 px-2.5 py-1 text-[11px] font-medium text-amber-800 hover:bg-amber-100 disabled:opacity-60 dark:border-amber-800 dark:bg-amber-950/30 dark:text-amber-300"
          >
            <Zap className="h-3 w-3" />
            Carry out this plan with Agent
          </button>
        )}
      </div>
    </div>
  );
}
