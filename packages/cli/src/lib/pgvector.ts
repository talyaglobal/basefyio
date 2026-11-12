/**
 * Pure helpers behind `basefyio pgvector …`.
 *
 * Nothing here talks to the network or the terminal, so what the CLI reports
 * about a project's vector store — and, above all, whether it claims that data
 * was removed — can be tested without a server.
 */

// ── Shapes returned by the platform API ───────────────────────────────────

/** `GET /api/projects/:id/embeddings/status`. Fields are optional where older APIs omit them. */
export interface EmbeddingStatus {
  pgvectorEnabled: boolean;
  pgvectorEnabledAt: string | null;
  hasApiKey?: boolean;
  /** Stored vectors; null when the tables could not be read. */
  embeddingCount: number | null;
  provider?: string;
  providerName?: string;
  model?: string;
  configSource?: 'project' | 'platform';
  keySource?: 'project' | 'platform' | 'none';
  requiresApiKey?: boolean;
  baseUrl?: string | null;
  dimensions?: number | null;
  storedDimensions?: number | null;
  padded?: boolean;
  dataRegion?: { code: string | null; label: string } | null;
  reembed?: {
    status: 'QUEUED' | 'RUNNING' | 'COMPLETED' | 'FAILED';
    done: number;
    total: number;
    error?: string;
  } | null;
}

/** `DELETE /api/projects/:id/embeddings/enable`. `dataDropped` is absent on APIs that cannot drop data. */
export interface DisablePgvectorResponse {
  message?: string;
  projectId?: string;
  dataDropped?: boolean;
}

// ── Formatting ────────────────────────────────────────────────────────────

/** "1 embedding", "2 embeddings". */
export function pluralize(count: number, singular: string, plural = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : plural}`;
}

/** Label/value rows for `basefyio pgvector status`, in display order. */
export function embeddingStatusRows(status: EmbeddingStatus): Array<[string, string]> {
  const rows: Array<[string, string]> = [];
  rows.push(['pgvector', status.pgvectorEnabled ? 'enabled' : 'disabled']);
  if (status.pgvectorEnabledAt) {
    rows.push([status.pgvectorEnabled ? 'Enabled at' : 'Last enabled at', new Date(status.pgvectorEnabledAt).toLocaleString()]);
  }
  if (status.pgvectorEnabled) {
    rows.push([
      'Stored vectors',
      status.embeddingCount == null
        ? 'unknown (the embedding tables could not be read)'
        : pluralize(status.embeddingCount, 'embedding'),
    ]);
  }
  if (status.providerName || status.provider) {
    const source = status.configSource === 'project' ? 'project setting' : 'platform default';
    rows.push(['Provider', `${status.providerName ?? status.provider} (${source})`]);
  }
  if (status.model) rows.push(['Model', status.model]);
  if (status.dimensions) {
    const stored =
      status.storedDimensions && status.storedDimensions !== status.dimensions
        ? `, stored as ${status.storedDimensions}${status.padded ? ' (padded)' : ''}`
        : '';
    rows.push(['Dimensions', `${status.dimensions}${stored}`]);
  }
  if (status.keySource) {
    rows.push(['API key', describeKeySource(status.keySource, status.requiresApiKey)]);
  }
  if (status.baseUrl) rows.push(['Endpoint', status.baseUrl]);
  if (status.dataRegion?.label) rows.push(['Data region', status.dataRegion.label]);
  if (status.reembed) {
    const r = status.reembed;
    const progress = r.total ? ` ${r.done}/${r.total}` : '';
    rows.push(['Re-embedding', `${r.status.toLowerCase()}${progress}${r.error ? ` — ${r.error}` : ''}`]);
  }
  return rows;
}

function describeKeySource(source: 'project' | 'platform' | 'none', required?: boolean): string {
  if (source === 'project') return 'project key';
  if (source === 'platform') return 'platform key';
  return required === false ? 'not needed' : 'missing — add one in the dashboard (AI / Embeddings)';
}

/**
 * What to tell the user after a disable.
 *
 * The API only reports `dataDropped: true` when it really removed the tables,
 * so anything else — including an older API that ignores the request — is
 * reported as "kept". The CLI never claims a deletion it cannot see.
 */
export function describeDisableOutcome(
  dropRequested: boolean,
  response: DisablePgvectorResponse | null | undefined,
): { level: 'success' | 'warning'; lines: string[] } {
  const dropped = response?.dataDropped === true;
  if (dropped) {
    return {
      level: 'success',
      lines: ['pgvector disabled and the stored embeddings were deleted.'],
    };
  }
  if (dropRequested) {
    return {
      level: 'warning',
      lines: [
        'pgvector disabled, but the stored embeddings were NOT deleted:',
        'the API did not confirm the deletion. They stay in the project database until you remove them.',
      ],
    };
  }
  return {
    level: 'success',
    lines: [
      'pgvector disabled. Stored embeddings were kept; enabling pgvector again makes them searchable again.',
    ],
  };
}
