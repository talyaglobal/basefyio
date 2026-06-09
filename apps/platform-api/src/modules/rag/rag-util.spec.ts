import {
  isIncompleteStatus,
  RAG_INCOMPLETE_STATUSES,
  searchLimitValid,
  searchThresholdValid,
  ragJobDedupeKey,
  clampImportance,
  importanceValid,
} from './rag-util';

describe('rag-util', () => {
  describe('isIncompleteStatus / reindex-incomplete target set', () => {
    it('includes only FAILED, PENDING, STALE', () => {
      expect([...RAG_INCOMPLETE_STATUSES].sort()).toEqual([
        'FAILED',
        'PENDING',
        'STALE',
      ]);
      expect(isIncompleteStatus('FAILED')).toBe(true);
      expect(isIncompleteStatus('PENDING')).toBe(true);
      expect(isIncompleteStatus('STALE')).toBe(true);
    });

    it('excludes INDEXED and PROCESSING', () => {
      expect(isIncompleteStatus('INDEXED')).toBe(false);
      expect(isIncompleteStatus('PROCESSING')).toBe(false);
    });
  });

  describe('search limit validation (1–25)', () => {
    it.each([1, 8, 25])('accepts %i', (n) => {
      expect(searchLimitValid(n)).toBe(true);
    });
    it.each([0, 26, -1, 1.5, NaN, Infinity])('rejects %p', (n) => {
      expect(searchLimitValid(n as number)).toBe(false);
    });
  });

  describe('search threshold validation (0–1)', () => {
    it.each([0, 0.45, 1])('accepts %p', (n) => {
      expect(searchThresholdValid(n)).toBe(true);
    });
    it.each([-0.01, 1.01, NaN, Infinity])('rejects %p', (n) => {
      expect(searchThresholdValid(n as number)).toBe(false);
    });
  });

  describe('ragJobDedupeKey', () => {
    it('always embeds projectId so keys never collide across projects', () => {
      const a = ragJobDedupeKey({ projectId: 'p1', kind: 'INDEX', documentId: 'd' });
      const b = ragJobDedupeKey({ projectId: 'p2', kind: 'INDEX', documentId: 'd' });
      expect(a).not.toEqual(b);
      expect(a.startsWith('p1:')).toBe(true);
    });

    it('is stable for identical inputs (idempotency)', () => {
      const k1 = ragJobDedupeKey({ projectId: 'p', kind: 'INDEX', documentId: 'd' });
      const k2 = ragJobDedupeKey({ projectId: 'p', kind: 'INDEX', documentId: 'd' });
      expect(k1).toEqual(k2);
    });

    it('differs when source hash changes', () => {
      const k1 = ragJobDedupeKey({ projectId: 'p', kind: 'INDEX', documentId: 'd', sourceHash: 'h1' });
      const k2 = ragJobDedupeKey({ projectId: 'p', kind: 'INDEX', documentId: 'd', sourceHash: 'h2' });
      expect(k1).not.toEqual(k2);
    });

    it('without a nonce stays stable (idempotent ingest)', () => {
      expect(ragJobDedupeKey({ projectId: 'p', kind: 'INDEX', documentId: 'd' })).toEqual(
        ragJobDedupeKey({ projectId: 'p', kind: 'INDEX', documentId: 'd' }),
      );
    });

    it('with a nonce produces a fresh key each time (reindex can rerun)', () => {
      const a = ragJobDedupeKey({ projectId: 'p', kind: 'REINDEX', documentId: 'd', nonce: 1 });
      const b = ragJobDedupeKey({ projectId: 'p', kind: 'REINDEX', documentId: 'd', nonce: 2 });
      expect(a).not.toEqual(b);
    });
  });

  describe('importance', () => {
    it('clamps to 0–100', () => {
      expect(clampImportance(-5)).toBe(0);
      expect(clampImportance(250)).toBe(100);
      expect(clampImportance(42)).toBe(42);
    });
    it('validates range', () => {
      expect(importanceValid(0)).toBe(true);
      expect(importanceValid(100)).toBe(true);
      expect(importanceValid(101)).toBe(false);
      expect(importanceValid(-1)).toBe(false);
    });
  });
});
