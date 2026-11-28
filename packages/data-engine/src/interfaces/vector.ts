/**
 * basefyio Data Engine — vector types.
 *
 * A record can carry one embedding next to its operational data. The vector
 * is stored beside the document (never inside the user's `data`), is unit
 * normalised at write time, and is never returned by the ordinary read paths.
 * Similarity is cosine: `distance = 1 - cos(a, b)` in 0..2, `score = 1 - distance`.
 *
 * No vendor-specific types may appear here.
 */

import type { DocResult } from './types';
import type { Filter } from './query';

/** Options shared by vector writes. */
export interface VectorWriteOptions {
  /**
   * The width the entity is configured for. When set, a vector of any other
   * length is a VectorDimensionError.
   */
  dimensions?: number;
  /** Who produced the vector. Stage 1 only stores client-supplied vectors. */
  model?: string;
}

/** One item of a batch vector write. */
export interface VectorWrite {
  id: string;
  vector: number[];
}

/** Outcome of a batch write: ids written, and ids with no live record in scope. */
export interface VectorWriteResult {
  written: string[];
  missing: string[];
}

/** The vector stored on a record (unit normalised, float32 precision). */
export interface VectorInfo {
  id: string;
  dims: number;
  model: string;
  source: string;
  updatedAt: string;
  vector: number[];
}

export interface VectorSearchQuery {
  /** Query vector; normalised before scoring. */
  vector: number[];
  /** Same filter AST as list queries; applied before scoring. */
  filter?: Filter;
  /** Number of hits, 1..100 (default 10). */
  limit?: number;
  /** Keep only hits whose cosine distance is below this value (0..2). Omitted = no threshold. */
  maxDistance?: number;
  /** The width the entity is configured for; a query of another length is a VectorDimensionError. */
  dimensions?: number;
}

export interface VectorHit {
  doc: DocResult;
  /** Cosine distance, 0 (same direction) .. 2 (opposite). */
  distance: number;
  /** 1 - distance. */
  score: number;
}

export interface VectorSearchResult {
  hits: VectorHit[];
  /** Candidate vectors scored for this query. */
  scanned: number;
  strategy: 'exact' | 'ann';
}

export interface VectorStats {
  /** Live records of the entity that carry a vector. */
  embedded: number;
  /** Live records of the entity. */
  total: number;
}
