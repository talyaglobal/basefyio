import { HttpClient } from '../http';
import type { SqlExecuteOptions, SqlResult } from '../types';

export class SqlResource {
  constructor(
    private readonly http: HttpClient,
    private readonly projectId: string,
  ) {}

  execute<T = Record<string, unknown>>(
    query: string,
    opts: SqlExecuteOptions = {},
  ): Promise<SqlResult<T>> {
    return this.http.post('/sql/execute', {
      projectId: this.projectId,
      query,
      ...opts,
    });
  }
}
