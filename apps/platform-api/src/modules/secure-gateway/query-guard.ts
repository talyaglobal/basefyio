import {
  ForbiddenException,
  Injectable,
  PayloadTooLargeException,
  RequestTimeoutException,
} from '@nestjs/common';
import type { QueryResult } from './data-storage-provider.interface';

// DML + DDL keywords that mutate state
const MUTATING_PATTERN =
  /^\s*(INSERT|UPDATE|DELETE|DROP|CREATE|ALTER|TRUNCATE|REPLACE|MERGE|UPSERT|GRANT|REVOKE|COPY|VACUUM|REINDEX|CLUSTER)\b/i;

@Injectable()
export class QueryGuard {
  /**
   * Throws ForbiddenException when a READ-only cert attempts a mutating query.
   * Mutating queries: INSERT, UPDATE, DELETE, DDL (DROP, CREATE, ALTER, …).
   */
  assertQueryAllowed(sql: string, accessLevel: 'READ' | 'READ_WRITE'): void {
    if (accessLevel === 'READ_WRITE') return;
    if (MUTATING_PATTERN.test(sql)) {
      throw new ForbiddenException(
        'Certificate has READ-only access. Mutating queries (INSERT, UPDATE, DELETE, DDL) are not permitted.',
      );
    }
  }

  /**
   * Caps the result rows to maxRows.
   * Sets truncated=true when rows were dropped.
   */
  applyRowLimit(result: QueryResult, maxRows: number): QueryResult {
    if (result.rows.length <= maxRows) return result;
    return { rows: result.rows.slice(0, maxRows), rowCount: result.rowCount, truncated: true };
  }

  /**
   * Throws PayloadTooLargeException when the serialised row payload exceeds maxBytes.
   * Called before applyRowLimit so large individual rows are also caught.
   */
  assertPayloadSize(result: QueryResult, maxBytes: number): void {
    const size = Buffer.byteLength(JSON.stringify(result.rows));
    if (size > maxBytes) {
      throw new PayloadTooLargeException(
        `Query result size (${size} bytes) exceeds the maximum allowed (${maxBytes} bytes).`,
      );
    }
  }

  /**
   * Races the given promise against a timeout.
   * Throws RequestTimeoutException if the timeout fires first.
   */
  async withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const race = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new RequestTimeoutException(`Query exceeded the ${timeoutMs}ms timeout limit.`)),
        timeoutMs,
      );
    });
    try {
      return await Promise.race([promise, race]);
    } finally {
      clearTimeout(timer);
    }
  }
}
