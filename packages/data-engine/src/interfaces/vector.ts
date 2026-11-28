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
  /** Model tag of the vector ("client" when the caller does not say). */
  model?: string;
  /** Who produced the vector: the caller ("client", the default) or the platform from the record's text. */
  source?: VectorSource;
  /** sha256 (hex) of the source text a platform vector was computed from. */
  hash?: string | null;
  /**
   * Write only while the record is still at this envelope version. A record
   * that changed in between is a ConcurrencyError, so a worker never stores a
   * vector for text the record no longer holds. (Batch writes report such ids
   * as missing.)
   */
  ifVersion?: number;
}

export type VectorSource = 'client' | 'platform';

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
export interface VectorInfo extends VectorMeta {
  vector: number[];
}

/** What is stored about a record's vector, without the vector itself. */
export interface VectorMeta {
  id: string;
  dims: number;
  model: string;
  source: string;
  /** sha256 of the source text (platform vectors), null for client vectors. */
  hash: string | null;
  updatedAt: string;
}

/**
 * Platform bookkeeping for a record that has no usable vector for the
 * current model: its source text was empty, or embedding it failed.
 */
export interface VectorMarker {
  kind: 'empty' | 'failed';
  model: string;
  hash: string | null;
  /** Short reason for a failure (never a credential). */
  error?: string | null;
  updatedAt: string;
}

/** Ids and source fields of the records a platform embedder works through. */
export interface VectorSourceQuery {
  /** Dot paths under the record's data to return (1..8). */
  paths: string[];
  /** Only these ids (still pinned to the entity scope). */
  ids?: string[];
  /** Page after this id (ascending id order). */
  after?: string;
  /** Page size, 1..500 (default 100). */
  limit?: number;
}

export interface VectorSourceRow {
  id: string;
  /** Envelope version the data was read at (for a conditional vector write). */
  version: number;
  /** The record's data, reduced to the requested paths. */
  data: Record<string, unknown>;
  vector: VectorMeta | null;
  marker: VectorMarker | null;
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
  /**
   * Only with `model`: live records whose vector is missing or was made with
   * another model, and that carry no marker for this model.
   */
  pending?: number;
  /** Only with `model`: live records whose last embedding with this model failed. */
  failed?: number;
}

export interface VectorStatsOptions {
  /** The model tag platform vectors should be made with; adds `pending` and `failed`. */
  model?: string;
}
