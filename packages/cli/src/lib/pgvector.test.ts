import { describe, expect, it } from 'vitest';
import { describeDisableOutcome, embeddingStatusRows, pluralize, type EmbeddingStatus } from './pgvector';

const status = (over: Partial<EmbeddingStatus> = {}): EmbeddingStatus => ({
  pgvectorEnabled: true,
  pgvectorEnabledAt: '2026-10-01T10:00:00.000Z',
  hasApiKey: true,
  embeddingCount: 1,
  provider: 'openai',
  providerName: 'OpenAI',
  model: 'text-embedding-3-small',
  configSource: 'platform',
  keySource: 'platform',
  requiresApiKey: true,
  baseUrl: null,
  dimensions: 1536,
  storedDimensions: 1536,
  padded: false,
  dataRegion: { code: 'US', label: 'United States' },
  reembed: null,
  ...over,
});

const value = (rows: Array<[string, string]>, label: string) => rows.find(([l]) => l === label)?.[1];

describe('pluralize', () => {
  it('uses the singular for exactly one', () => {
    expect(pluralize(1, 'embedding')).toBe('1 embedding');
    expect(pluralize(0, 'embedding')).toBe('0 embeddings');
    expect(pluralize(2, 'embedding')).toBe('2 embeddings');
  });
});

describe('embeddingStatusRows', () => {
  it('describes an enabled store', () => {
    const rows = embeddingStatusRows(status());
    expect(value(rows, 'pgvector')).toBe('enabled');
    expect(value(rows, 'Stored vectors')).toBe('1 embedding');
    expect(value(rows, 'Provider')).toBe('OpenAI (platform default)');
    expect(value(rows, 'Dimensions')).toBe('1536');
    expect(value(rows, 'API key')).toBe('platform key');
    expect(value(rows, 'Data region')).toBe('United States');
  });

  it('does not claim a count it could not read', () => {
    expect(value(embeddingStatusRows(status({ embeddingCount: null })), 'Stored vectors')).toMatch(/^unknown/);
  });

  it('omits the vector count while disabled and labels the old enable date', () => {
    const rows = embeddingStatusRows(status({ pgvectorEnabled: false }));
    expect(value(rows, 'pgvector')).toBe('disabled');
    expect(value(rows, 'Stored vectors')).toBeUndefined();
    expect(value(rows, 'Last enabled at')).toBeDefined();
  });

  it('flags a missing key only when the provider needs one', () => {
    expect(value(embeddingStatusRows(status({ keySource: 'none' })), 'API key')).toMatch(/^missing/);
    expect(
      value(embeddingStatusRows(status({ keySource: 'none', requiresApiKey: false })), 'API key'),
    ).toBe('not needed');
  });

  it('shows a padded store width and a running re-embed', () => {
    const rows = embeddingStatusRows(
      status({
        dimensions: 1024,
        storedDimensions: 1536,
        padded: true,
        reembed: { status: 'RUNNING', done: 10, total: 40 },
      }),
    );
    expect(value(rows, 'Dimensions')).toBe('1024, stored as 1536 (padded)');
    expect(value(rows, 'Re-embedding')).toBe('running 10/40');
  });
});

describe('describeDisableOutcome', () => {
  it('reports kept data on a plain disable', () => {
    const out = describeDisableOutcome(false, { message: 'pgvector disabled', dataDropped: false });
    expect(out.level).toBe('success');
    expect(out.lines.join(' ')).toMatch(/kept/);
  });

  it('reports deletion only when the API confirms it', () => {
    const out = describeDisableOutcome(true, { dataDropped: true });
    expect(out.level).toBe('success');
    expect(out.lines.join(' ')).toMatch(/deleted/);
  });

  it('warns when deletion was asked for but not confirmed (older API)', () => {
    for (const response of [{ message: 'pgvector disabled' }, { dataDropped: false }, null]) {
      const out = describeDisableOutcome(true, response);
      expect(out.level).toBe('warning');
      expect(out.lines.join(' ')).toMatch(/NOT deleted/);
    }
  });
});
