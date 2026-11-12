import { clearTokens, getAccessToken, getRefreshToken, setTokens } from './auth';
import type { AuthTokens } from './types';

/** Response shapes of the /ai routes (see AiService in platform-api). */

export type AiMode = 'ask' | 'plan' | 'agent';

export interface AiStatementResult {
  sql: string;
  ok: boolean;
  command: string;
  rowCount: number | null;
  fields: string[];
  rows: Record<string, unknown>[];
  truncated: boolean;
  error?: string;
  durationMs: number;
}

export interface AiVerification {
  label: string;
  passed: boolean;
}

export interface AiProposedStatement {
  sql: string;
  kind: 'read' | 'write' | 'schema' | 'transaction' | 'other';
  command: string;
  destructive: boolean;
  warning: string | null;
}

export interface AiProposalView {
  id: string;
  projectId: string;
  statements: AiProposedStatement[];
  createdAt: string;
  expiresAt: string;
}

export interface AiQueryEvent {
  index: number;
  sql: string;
  results: AiStatementResult[];
}

export interface AiProposalEvent {
  index: number;
  proposal: AiProposalView | null;
  sql: string;
  statements: AiProposedStatement[];
  validation: { status: 'passed' | 'failed' | 'partial' | 'skipped'; error: string | null; notes: string[] };
  correctedFrom: string | null;
}

export interface AiApplyResult {
  proposalId: string;
  ok: boolean;
  atomic: boolean;
  failedIndex: number | null;
  statements: (AiStatementResult & { verification: AiVerification[] })[];
  /** Built by the server from the database, never by the model. */
  summary: string;
}

export interface AiProviderInfo {
  id: 'openai' | 'gemini' | 'anthropic';
  name: string;
  defaultModel: string;
  models: string[];
  keyPlaceholder: string;
  keyHelpUrl: string;
}

export interface AiAssistantSettings {
  provider: AiProviderInfo['id'] | null;
  model: string | null;
  keyHint: string | null;
  updatedAt: string | null;
  platform: { provider: string; model: string; available: boolean };
  providers: AiProviderInfo[];
}

export type AiStreamEvent =
  | { event: 'meta'; data: { provider: string; model: string; source: 'project' | 'platform'; projectId: string | null; tables: number | null } }
  | { event: 'status'; data: { phase: string; label: string } }
  | { event: 'delta'; data: { part: 'reply' | 'followup'; text: string } }
  | { event: 'query'; data: AiQueryEvent }
  | { event: 'proposal'; data: AiProposalEvent }
  | { event: 'done'; data: { reply: string; followup: string; stopped: boolean } }
  | { event: 'error'; data: { message: string; code?: string } };

export interface AiChatRequest {
  message: string;
  history: { role: 'user' | 'assistant'; content: string }[];
  context: { projectId?: string; projectName?: string; page?: string; mode: AiMode };
}

async function refreshTokens(): Promise<'ok' | 'rejected' | 'unavailable'> {
  const refreshToken = getRefreshToken();
  if (!refreshToken) return 'rejected';
  try {
    const res = await fetch('/api/proxy/auth/refresh', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refreshToken }),
    });
    if (res.ok) {
      setTokens((await res.json()) as AuthTokens);
      return 'ok';
    }
    return res.status === 400 || res.status === 401 ? 'rejected' : 'unavailable';
  } catch {
    return 'unavailable';
  }
}

/**
 * Stream one assistant turn. Events arrive through `onEvent` as the server
 * sends them; aborting `signal` stops the model on the server too. An expired
 * access token is refreshed silently and the request retried once; only a
 * refresh the server rejects sends the person to /login.
 */
export async function streamAiChat(
  body: AiChatRequest,
  onEvent: (e: AiStreamEvent) => void,
  signal: AbortSignal,
): Promise<void> {
  const send = () =>
    fetch('/api/proxy/ai/chat/stream', {
      method: 'POST',
      signal,
      headers: {
        'Content-Type': 'application/json',
        Accept: 'text/event-stream',
        ...(getAccessToken() ? { Authorization: `Bearer ${getAccessToken()}` } : {}),
      },
      body: JSON.stringify(body),
    });

  let res = await send();
  if (res.status === 401) {
    const refreshed = await refreshTokens();
    if (refreshed === 'rejected') {
      clearTokens();
      if (typeof window !== 'undefined' && !window.location.pathname.startsWith('/login')) {
        window.location.assign('/login');
      }
      throw new Error('Signing you in again…');
    }
    if (refreshed === 'unavailable') throw new Error('Connection issue while refreshing your session. Please retry.');
    res = await send();
  }
  if (!res.ok || !res.body) {
    const text = await res.text().catch(() => '');
    let message = `The assistant is unavailable (${res.status}).`;
    try {
      const parsed = JSON.parse(text) as { message?: string | string[] };
      if (parsed.message) message = Array.isArray(parsed.message) ? parsed.message.join(', ') : parsed.message;
    } catch {
      /* not JSON */
    }
    throw new Error(message);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let sep: number;
    while ((sep = buffer.search(/\r?\n\r?\n/)) !== -1) {
      const frame = buffer.slice(0, sep);
      buffer = buffer.slice(sep).replace(/^\r?\n\r?\n/, '');
      const parsed = parseFrame(frame);
      if (parsed) onEvent(parsed);
    }
  }
  const tail = parseFrame(buffer);
  if (tail) onEvent(tail);
}

function parseFrame(frame: string): AiStreamEvent | null {
  let event = 'message';
  const data: string[] = [];
  for (const line of frame.split(/\r?\n/)) {
    if (line.startsWith(':')) continue;
    if (line.startsWith('event:')) event = line.slice(6).trim();
    else if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''));
  }
  if (!data.length) return null;
  try {
    return { event, data: JSON.parse(data.join('\n')) } as AiStreamEvent;
  } catch {
    return null;
  }
}

/**
 * Whether a SQL block only reads. The server decides for real; this only picks
 * the button label ("Run" or "Review change").
 */
export function looksReadOnly(sql: string): boolean {
  const statements = sql
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/--[^\n]*/g, ' ')
    .split(';')
    .map((s) => s.trim())
    .filter(Boolean);
  if (!statements.length) return false;
  return statements.every((s) => {
    const lead = s.split(/\s+/)[0]?.toUpperCase() ?? '';
    if (!['SELECT', 'WITH', 'SHOW', 'EXPLAIN', 'TABLE', 'VALUES'].includes(lead)) return false;
    const upper = s.toUpperCase();
    if (lead === 'WITH' && /\b(INSERT|UPDATE|DELETE|MERGE)\b/.test(upper)) return false;
    if (lead === 'EXPLAIN' && /\bANALY[SZ]E\b/.test(upper)) return false;
    return !(lead === 'SELECT' && /\bINTO\b/.test(upper));
  });
}
