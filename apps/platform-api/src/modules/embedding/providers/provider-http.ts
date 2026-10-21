import {
  EmbeddingProviderError,
  EmbeddingProviderId,
  REQUEST_TIMEOUT_MS,
  kindForStatus,
} from './embedding-provider';

export interface JsonResponse<T> {
  status: number;
  body: T;
}

/**
 * POST a JSON body and parse a JSON response, with a timeout. Network-level
 * failures (DNS, refused connection, abort) become `unavailable`; non-2xx
 * responses become an error whose kind follows the status code and whose
 * message carries the provider's own text when it sent any.
 */
export async function postJson<T>(
  provider: EmbeddingProviderId,
  url: string,
  body: unknown,
  headers: Record<string, string>,
  signal?: AbortSignal,
): Promise<JsonResponse<T>> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  const onOuterAbort = () => controller.abort();
  signal?.addEventListener('abort', onOuterAbort, { once: true });

  let res: Response;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        ...headers,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (err: any) {
    const detail = err?.name === 'AbortError' ? 'timed out' : String(err?.cause?.message ?? err?.message ?? err);
    throw new EmbeddingProviderError(
      provider,
      undefined,
      'unavailable',
      `Could not reach ${provider} at ${hostOf(url)}: ${detail}`,
    );
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onOuterAbort);
  }

  const text = await res.text().catch(() => '');
  let parsed: unknown = null;
  if (text.trim()) {
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = null;
    }
  }

  if (!res.ok) {
    const providerMessage = extractMessage(parsed) ?? text.slice(0, 300);
    throw new EmbeddingProviderError(
      provider,
      res.status,
      kindForStatus(res.status),
      providerMessage
        ? `${provider} returned HTTP ${res.status}: ${providerMessage}`
        : `${provider} returned HTTP ${res.status}`,
    );
  }

  if (parsed === null) {
    throw new EmbeddingProviderError(
      provider,
      res.status,
      'unknown',
      `${provider} returned a non-JSON response`,
    );
  }
  return { status: res.status, body: parsed as T };
}

function extractMessage(body: unknown): string | null {
  if (!body || typeof body !== 'object') return null;
  const b = body as Record<string, unknown>;
  const candidates = [b.message, b.error, (b.error as any)?.message, b.detail];
  for (const c of candidates) {
    if (typeof c === 'string' && c.trim()) return c.trim().slice(0, 300);
  }
  return null;
}

export function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}
