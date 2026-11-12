import {
  BadRequestException,
  ConflictException,
  HttpException,
  HttpStatus,
  InternalServerErrorException,
  NotFoundException,
  NotImplementedException,
  PayloadTooLargeException,
  ServiceUnavailableException,
  UnprocessableEntityException,
} from '@nestjs/common';
import {
  normalizeFilterInput,
  normalizeSelectInput,
  normalizeSortInput,
} from '@basefyio/data-engine';
import type { EntityQuery, Filter, PathRef } from '@basefyio/data-engine';

/**
 * HTTP plumbing for the Data Engine routes, kept free of Nest wiring so it is
 * unit tested on its own: error → status mapping, If-Match parsing, list
 * parameter parsing and response projection.
 */

const MAX_LIMIT = 1000;
const DEFAULT_LIMIT = 50;

interface EngineErrorLike {
  message: string;
  code: string;
  statusCode: number;
  errors?: Array<{ path: string; message: string }>;
}

/** Duck-typed: the engine package may be loaded twice, so instanceof is not reliable. */
function isEngineError(err: unknown): err is EngineErrorLike {
  const e = err as Partial<EngineErrorLike> | null;
  return (
    !!e &&
    typeof e === 'object' &&
    typeof e.code === 'string' &&
    typeof e.statusCode === 'number' &&
    typeof e.message === 'string'
  );
}

/**
 * Map an engine error to the matching HTTP exception. Client errors keep
 * their message and machine-readable `code`; anything unexpected (a driver
 * error, a bug) becomes a generic 500 so store internals never reach the
 * client. The caller logs the original.
 */
export function toDataEngineHttpError(err: unknown): HttpException {
  if (err instanceof HttpException) return err;
  if (isEngineError(err)) {
    const body = { message: err.message, code: err.code };
    switch (err.statusCode) {
      case HttpStatus.BAD_REQUEST:
        return new BadRequestException(body);
      case HttpStatus.NOT_FOUND:
        return new NotFoundException(body);
      case HttpStatus.CONFLICT:
        return new ConflictException(body);
      case HttpStatus.PAYLOAD_TOO_LARGE:
        return new PayloadTooLargeException(body);
      case HttpStatus.UNPROCESSABLE_ENTITY:
        return new UnprocessableEntityException(body);
      case HttpStatus.NOT_IMPLEMENTED:
        return new NotImplementedException(body);
      case HttpStatus.SERVICE_UNAVAILABLE:
        return new ServiceUnavailableException(body);
      default:
        break;
    }
  }
  return new InternalServerErrorException({
    message: 'The Data Engine could not complete the request',
    code: 'DATA_ENGINE_ERROR',
  });
}

/**
 * True for errors raised on purpose (HTTP exceptions and engine errors with a
 * deliberate status); false for crashes and store failures, which get logged.
 */
export function isExpectedError(err: unknown): boolean {
  if (err instanceof HttpException) return true;
  return isEngineError(err) && err.statusCode !== 500 && err.statusCode !== 502;
}

/**
 * Parse an If-Match header into an expected document version.
 * Accepts `4`, `"4"` and `W/"4"`; `*` (or no header) means "any version".
 */
export function parseIfMatch(header: string | string[] | undefined): number | undefined {
  const raw = Array.isArray(header) ? header[0] : header;
  if (raw === undefined) return undefined;
  const value = raw.trim();
  if (value === '' || value === '*') return undefined;
  const m = /^(?:W\/)?"?(\d{1,15})"?$/.exec(value);
  if (!m) {
    throw new BadRequestException({
      message: `If-Match must be a document version such as "4" (the document's _version), got ${value}`,
      code: 'INVALID_IF_MATCH',
    });
  }
  return Number(m[1]);
}

/** The ETag of a document is its version, as a strong entity tag. */
export function etagFor(doc: { _version?: unknown }): string | undefined {
  return typeof doc?._version === 'number' ? `"${doc._version}"` : undefined;
}

function parseNonNegativeInt(raw: string | undefined, name: string): number | undefined {
  if (raw === undefined || raw === '') return undefined;
  if (!/^\d+$/.test(raw.trim())) {
    throw new BadRequestException({
      message: `${name} must be a non-negative integer, got "${raw}"`,
      code: 'INVALID_PAGINATION',
    });
  }
  return Number(raw.trim());
}

export function parseBooleanFlag(raw: string | undefined): boolean {
  return raw === 'true' || raw === '1';
}

export interface ListQueryParams {
  filter?: string;
  sort?: string;
  select?: string;
  limit?: string;
  offset?: string;
  cursor?: string;
  includeSoftDeleted?: string;
}

/**
 * Parse and validate the list parameters of GET /data/:entity.
 *  - filter / sort / select accept every documented format (see request-input)
 *  - limit: 1..1000 (larger values are capped at 1000, as documented); 0,
 *    negative or non-numeric values are a 400 instead of silently returning
 *    one or all documents
 *  - cursor: the `nextCursor` of the previous page; it takes precedence over offset
 */
export function parseListQuery(entity: string, q: ListQueryParams): EntityQuery {
  const limitRaw = parseNonNegativeInt(q.limit, 'limit');
  if (limitRaw === 0) {
    throw new BadRequestException({
      message: `limit must be between 1 and ${MAX_LIMIT}`,
      code: 'INVALID_PAGINATION',
    });
  }
  const limit = Math.min(limitRaw ?? DEFAULT_LIMIT, MAX_LIMIT);

  let offset = parseNonNegativeInt(q.offset, 'offset') ?? 0;
  if (q.cursor !== undefined && q.cursor !== '') {
    const fromCursor = parseNonNegativeInt(q.cursor, 'cursor');
    if (fromCursor === undefined) {
      throw new BadRequestException({ message: 'cursor is invalid', code: 'INVALID_PAGINATION' });
    }
    offset = fromCursor;
  }

  return {
    entity,
    filter: normalizeFilterInput(q.filter),
    sort: normalizeSortInput(q.sort),
    select: normalizeSelectInput(q.select),
    limit,
    offset,
    includeSoftDeleted: parseBooleanFlag(q.includeSoftDeleted),
  };
}

export function parseFilterQuery(raw: string | undefined): Filter | undefined {
  return normalizeFilterInput(raw);
}

function getPath(obj: unknown, segments: string[]): unknown {
  let cur: unknown = obj;
  for (const seg of segments) {
    if (cur === null || typeof cur !== 'object' || Array.isArray(cur)) return undefined;
    cur = (cur as Record<string, unknown>)[seg];
  }
  return cur;
}

function setPath(target: Record<string, unknown>, segments: string[], value: unknown): void {
  let cur = target;
  for (let i = 0; i < segments.length - 1; i++) {
    const seg = segments[i];
    if (typeof cur[seg] !== 'object' || cur[seg] === null || Array.isArray(cur[seg])) cur[seg] = {};
    cur = cur[seg] as Record<string, unknown>;
  }
  cur[segments[segments.length - 1]] = value;
}

/**
 * Apply a projection to a document: the envelope (`_*` fields) is always
 * kept, user fields only when selected. Providers that project natively
 * return the same shape, so applying it again is harmless.
 */
export function projectDocument<T extends Record<string, unknown>>(doc: T, select: PathRef[] | undefined): T {
  if (!select || select.length === 0) return doc;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(doc)) {
    if (key.startsWith('_')) out[key] = value;
  }
  for (const ref of select) {
    const segments = ref.path.replace(/\[\]/g, '').split('.');
    const value = getPath(doc, segments);
    if (value !== undefined) setPath(out, segments, value);
  }
  return out as T;
}

export function entityNotRegisteredMessage(entity: string): string {
  return (
    `Entity "${entity}" is not registered in the Data Engine. Create it with POST /api/v1/projects/:projectId/entities. ` +
    `If "${entity}" is a JSON collection created in the dashboard, it lives in the project database instead: ` +
    `use /api/projects/:projectId/collections/${entity}/documents (or /api/rest/v1/collections/${entity} from an app).`
  );
}
