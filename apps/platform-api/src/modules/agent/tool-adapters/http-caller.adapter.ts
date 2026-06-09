import { Injectable, Logger } from '@nestjs/common';
import { HttpService } from '@nestjs/axios';
import { firstValueFrom, timeout } from 'rxjs';
import type {
  ToolAdapter,
  ToolAdapterContext,
  ToolAdapterResult,
} from './tool-adapter.interface';

const REQUEST_TIMEOUT_MS = 15_000;
const MAX_BODY_BYTES = 64 * 1024; // 64 KB response cap

// Block requests to RFC-1918 private ranges and localhost.
const BLOCKED_HOST_PATTERN =
  /^(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|::1|0\.0\.0\.0)/i;

@Injectable()
export class HttpCallerAdapter implements ToolAdapter {
  readonly toolId = 'http_caller';
  private readonly logger = new Logger(HttpCallerAdapter.name);

  constructor(private readonly http: HttpService) {}

  async execute(
    input: Record<string, unknown>,
    ctx: ToolAdapterContext,
  ): Promise<ToolAdapterResult> {
    const url = typeof input.url === 'string' ? input.url.trim() : '';
    if (!url) {
      return { output: { error: 'url is required' } };
    }

    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      return { output: { error: `Invalid URL: ${url}` } };
    }

    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
      return { output: { error: 'Only http/https URLs are allowed.' } };
    }

    if (BLOCKED_HOST_PATTERN.test(parsed.hostname)) {
      return {
        output: { error: 'Requests to private/internal addresses are blocked.' },
      };
    }

    const method = (
      typeof input.method === 'string' ? input.method : 'GET'
    ).toUpperCase();

    const headers: Record<string, string> = {
      'User-Agent': 'KolayBase-Agent/1.0',
      ...(typeof input.headers === 'object' && input.headers !== null
        ? (input.headers as Record<string, string>)
        : {}),
    };

    const body =
      method !== 'GET' && method !== 'HEAD' && input.body !== undefined
        ? String(input.body)
        : undefined;

    try {
      const obs = this.http
        .request({ method, url, headers, data: body, maxContentLength: MAX_BODY_BYTES })
        .pipe(timeout(REQUEST_TIMEOUT_MS));

      const response = await firstValueFrom(obs);

      const responseBody =
        typeof response.data === 'string'
          ? response.data.slice(0, MAX_BODY_BYTES)
          : JSON.stringify(response.data).slice(0, MAX_BODY_BYTES);

      this.logger.log(
        `http_caller: ${method} ${url} → ${response.status} for run ${ctx.runId}`,
      );

      return {
        output: { status: response.status, body: responseBody },
        attachments: [
          {
            kind: 'http_response',
            content: {
              url,
              method,
              status: response.status,
              body: responseBody,
            },
          },
        ],
      };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.warn(`http_caller failed for run ${ctx.runId}: ${msg}`);
      return { output: { error: msg } };
    }
  }
}
