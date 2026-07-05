/**
 * Codefyio marketplace adapter — shared types. Framework-agnostic so the same
 * shapes are used by the in-process service, the HTTP controller, and the
 * importable {@link CodefyioAdapter} client.
 */

export interface Resource {
  id: string;
  name: string;
  kind: string;
  meta?: Record<string, unknown>;
}

export interface AdapterEvent {
  type: string;
  resourceId?: string;
  payload?: unknown;
}

export interface ActionRequest {
  action: string;
  resourceId?: string;
  params?: unknown;
}

export interface ActionResult {
  ok: boolean;
  result?: unknown;
  error?: string;
}

/** Verified claims from a Codefyio-issued JWT. */
export interface CodefyioClaims {
  sub: string;
  email: string;
  [k: string]: unknown;
}

/** Claims we embed in the short-lived adapter session token. */
export interface AdapterSessionClaims {
  userId: string;
  teamId: string;
  email: string;
}

/**
 * In-process adapter interface. The IDE (and tests) can drive the product
 * either over HTTP (see adapter.ts) or by calling a service that fulfils this
 * same contract.
 */
export interface CodefyioAdapter {
  init(ctx: { baseUrl: string; codefyioToken: string }): Promise<void>;
  authenticate(): Promise<{ account: string }>;
  getStatus(): Promise<{ status: 'ok' | 'degraded' | 'down'; detail?: string }>;
  listResources(cursor?: string): Promise<{ items: Resource[]; nextCursor?: string }>;
  executeAction(a: ActionRequest): Promise<ActionResult>;
  subscribe(onEvent: (e: AdapterEvent) => void): () => void;
}
