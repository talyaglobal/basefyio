/**
 * RAG chunker — pure, framework-free logic.
 *
 * Pipeline (matches the platform RAG contract):
 *   1. normalizeToJson(): the source object bytes are first converted to a
 *      canonical JSON document `{ text, format, meta }`. Chunking always runs
 *      over `text` so offsets are reproducible regardless of source format.
 *   2. chunk(): the normalized text is split into a *standard* bounded size and
 *      chained with overlap — each chunk starts slightly before the previous one
 *      ended, so sentence-to-sentence linkage survives the split.
 *
 * Why the two knobs matter (and why they are stored per-document):
 *   - Too little overlap  → chunks lose the thread between sentences and the
 *     language model produces nonsense at retrieval time.
 *   - Too large a chunk   → the embedding loses precision and induces
 *     hallucination.
 * The "sweet spot" between the two is data-dependent, so `chunkSize`,
 * `chunkOverlap`, `granularity` and {@link CHUNKER_VERSION} are persisted with
 * every document. Re-indexing with new params is therefore a re-run, never a
 * schema refactor.
 *
 * This module has ZERO NestJS / Prisma imports on purpose: it is unit-testable
 * in isolation and carries no platform coupling.
 */
import { Buffer } from 'node:buffer';

/** The three analysis granularities. Defaults to `sentence` (the usual sweet spot). */
export type RagGranularity = 'word' | 'sentence' | 'context';

export interface NormalizedDoc {
  /** Canonical plain text that chunking runs over. */
  text: string;
  /** Detected source format (e.g. `json`, `markdown`, `text`). */
  format: string;
  /** Any structured metadata carried from the source. */
  meta: Record<string, unknown>;
}

export interface RawChunk {
  index: number;
  content: string;
  /** Inclusive start offset into {@link NormalizedDoc.text}. */
  startOffset: number;
  /** Exclusive end offset into {@link NormalizedDoc.text}. */
  endOffset: number;
  /**
   * Number of characters this chunk shares with the *previous* chunk
   * (the chained-overlap tail). 0 for the first chunk.
   */
  overlapChars: number;
}

export interface ChunkOptions {
  /** Target characters per chunk (standard bounded size). */
  chunkSize?: number;
  /** Characters carried from the previous chunk to preserve linkage. */
  chunkOverlap?: number;
  granularity?: RagGranularity;
}

export const DEFAULT_CHUNK_SIZE = 1000;
export const DEFAULT_CHUNK_OVERLAP = 200;
export const DEFAULT_GRANULARITY: RagGranularity = 'sentence';

/**
 * Bump when the chunking algorithm changes in a way that invalidates stored
 * offsets/content. Persisted per document so stale chunks can be detected and
 * re-indexed without a database refactor.
 */
export const CHUNKER_VERSION = 'v1';

/** Hard bounds so a misconfigured request cannot create pathological chunks. */
export const MIN_CHUNK_SIZE = 100;
export const MAX_CHUNK_SIZE = 8000;

interface Atom {
  start: number;
  end: number;
}

/** Approximate token count (chars / 4) — same heuristic the embedding pipeline uses. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/**
 * Convert raw source bytes/string into a canonical JSON document.
 *
 * - `application/json` (or content that parses as JSON) → all string leaves are
 *   flattened, in a stable order, into a single text blob plus structured meta.
 * - everything else is treated as UTF-8 text (markdown / plain).
 *
 * Returns a JSON-serialisable object so the normalized form can be stored and
 * re-chunked deterministically.
 */
export function normalizeToJson(
  input: string | Uint8Array,
  contentType?: string,
): NormalizedDoc {
  const raw =
    typeof input === 'string' ? input : Buffer.from(input).toString('utf8');
  const ct = (contentType ?? '').toLowerCase();

  const looksJson =
    ct.includes('json') || /^\s*[[{]/.test(raw.slice(0, 64));

  if (looksJson) {
    try {
      const parsed = JSON.parse(raw);
      const parts: string[] = [];
      collectStrings(parsed, parts);
      return {
        text: parts.join('\n'),
        format: 'json',
        meta: { keys: Array.isArray(parsed) ? parsed.length : Object.keys(parsed ?? {}).length },
      };
    } catch {
      // fall through to text handling
    }
  }

  const format = ct.includes('markdown') || ct.includes('md') ? 'markdown' : 'text';
  return { text: raw, format, meta: {} };
}

function collectStrings(value: unknown, out: string[]): void {
  if (value == null) return;
  if (typeof value === 'string') {
    const t = value.trim();
    if (t) out.push(t);
    return;
  }
  if (typeof value === 'number' || typeof value === 'boolean') return;
  if (Array.isArray(value)) {
    for (const v of value) collectStrings(v, out);
    return;
  }
  if (typeof value === 'object') {
    for (const key of Object.keys(value as Record<string, unknown>)) {
      collectStrings((value as Record<string, unknown>)[key], out);
    }
  }
}

/**
 * Split normalized text into chained, overlapping chunks.
 *
 * Invariants (asserted by the unit tests):
 *  - chunks are returned in ascending `index`;
 *  - offsets are monotonic and within bounds;
 *  - when `chunkOverlap > 0` and more than one chunk is produced, every chunk
 *    after the first starts strictly before the previous chunk ended
 *    (`chunk[i].startOffset < chunk[i-1].endOffset`) — i.e. the chain overlaps;
 *  - concatenating non-overlapping spans reconstructs the original text.
 */
export function chunk(text: string, opts: ChunkOptions = {}): RawChunk[] {
  const chunkSize = clamp(
    opts.chunkSize ?? DEFAULT_CHUNK_SIZE,
    MIN_CHUNK_SIZE,
    MAX_CHUNK_SIZE,
  );
  const chunkOverlap = Math.max(
    0,
    Math.min(opts.chunkOverlap ?? DEFAULT_CHUNK_OVERLAP, Math.floor(chunkSize / 2)),
  );
  const granularity = opts.granularity ?? DEFAULT_GRANULARITY;

  // Split into atoms, then guarantee no atom exceeds the standard size: an
  // oversized sentence/paragraph is hard-split (words → char windows) so a
  // single long atom can never blow past chunkSize. Without this, "standard
  // bounded size" would not hold for punctuation-free or very long text.
  const atoms = enforceMaxAtomSize(text, splitAtoms(text, granularity), chunkSize);
  if (atoms.length === 0) return [];

  const chunks: RawChunk[] = [];
  let i = 0;
  let chunkIndex = 0;
  let prevEnd = -1;

  while (i < atoms.length) {
    // Greedily pack atoms until the next one would exceed the standard size.
    let j = i;
    let size = 0;
    while (j < atoms.length) {
      const atomLen = atoms[j].end - atoms[j].start;
      if (size > 0 && size + atomLen > chunkSize) break;
      size += atomLen;
      j++;
    }

    const start = atoms[i].start;
    const end = atoms[j - 1].end;
    const overlapChars = prevEnd >= 0 ? Math.max(0, prevEnd - start) : 0;

    chunks.push({
      index: chunkIndex++,
      content: text.slice(start, end),
      startOffset: start,
      endOffset: end,
      overlapChars,
    });
    prevEnd = end;

    if (j >= atoms.length) break;

    // Step back over trailing atoms to build the overlap tail for the next chunk,
    // so the next chunk starts before this one ended (chained).
    let back = j;
    let ov = 0;
    while (back > i + 1 && ov < chunkOverlap) {
      back--;
      ov += atoms[back].end - atoms[back].start;
    }
    i = back;
  }

  return chunks;
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}

/**
 * Split `text` into atoms with original-text offsets, by granularity.
 * Each atom spans `[start, end)` and includes its trailing whitespace so that
 * concatenating atoms reconstructs the source exactly.
 */
function splitAtoms(text: string, granularity: RagGranularity): Atom[] {
  if (text.length === 0) return [];

  if (granularity === 'word') {
    return boundaryAtoms(text, /\S+\s*/g);
  }
  if (granularity === 'context') {
    // Paragraph-level: blank-line separated blocks; fall back to sentences if
    // the text has no paragraph breaks.
    const paras = boundaryAtoms(text, /[\s\S]+?(?:\n\s*\n|$)/g);
    if (paras.length > 1) return paras;
    return splitAtoms(text, 'sentence');
  }
  // sentence (default): break on . ! ? followed by whitespace/end.
  const sentences = boundaryAtoms(text, /[\s\S]*?(?:[.!?]+(?:\s+|$)|$)/g);
  return sentences.length > 0 ? sentences : boundaryAtoms(text, /\S+\s*/g);
}

/**
 * Guarantee every atom is <= maxLen. Any oversized atom (a long sentence or
 * paragraph) is hard-split: first on word boundaries, and any single word still
 * longer than maxLen is sliced into fixed character windows. Offsets stay
 * absolute against the original text.
 */
function enforceMaxAtomSize(text: string, atoms: Atom[], maxLen: number): Atom[] {
  const out: Atom[] = [];
  for (const a of atoms) {
    if (a.end - a.start <= maxLen) {
      out.push(a);
      continue;
    }
    for (const w of wordAtomsInRange(text, a.start, a.end)) {
      if (w.end - w.start <= maxLen) {
        out.push(w);
      } else {
        for (let s = w.start; s < w.end; s += maxLen) {
          out.push({ start: s, end: Math.min(s + maxLen, w.end) });
        }
      }
    }
  }
  return out;
}

/** Word-boundary atoms within [start, end), offsets absolute. */
function wordAtomsInRange(text: string, start: number, end: number): Atom[] {
  const sub = text.slice(start, end);
  const re = /\S+\s*/g;
  const res: Atom[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(sub)) !== null) {
    if (m[0].length === 0) {
      re.lastIndex++;
      continue;
    }
    if (m[0].trim().length > 0) {
      res.push({ start: start + m.index, end: start + m.index + m[0].length });
    }
    if (re.lastIndex >= sub.length) break;
  }
  // No whitespace at all (one unbroken run) — return the whole range as one atom
  // so the char-window fallback in the caller can slice it.
  if (res.length === 0) res.push({ start, end });
  return res;
}

function boundaryAtoms(text: string, pattern: RegExp): Atom[] {
  const atoms: Atom[] = [];
  let m: RegExpExecArray | null;
  pattern.lastIndex = 0;
  while ((m = pattern.exec(text)) !== null) {
    const start = m.index;
    const end = start + m[0].length;
    if (end === start) {
      pattern.lastIndex++;
      continue;
    }
    if (m[0].trim().length > 0) {
      atoms.push({ start, end });
    }
    if (end >= text.length) break;
  }
  // Coalesce nothing — but make sure final tail is captured.
  if (atoms.length > 0) {
    const last = atoms[atoms.length - 1];
    if (last.end < text.length && text.slice(last.end).trim().length > 0) {
      atoms.push({ start: last.end, end: text.length });
    }
  }
  return atoms;
}
