/**
 * basefyio Data Engine — write-time document checks.
 *
 *  - assertDocumentBody      the body must be a JSON object
 *  - checkDocumentLimits     size, nesting depth and array length limits
 *  - validateDocument        the entity's field definitions (required, types,
 *                            nested objects, arrays, validation rules)
 *  - normalizeEntityFields   an entity definition's field list, before it is stored
 *
 * Validation applies to writes only. Documents already stored are always
 * readable, even when they no longer satisfy the current definition.
 */

import { DataEngineError, DocumentTooLargeError } from '../interfaces/data-engine';
import type { JsonObject, JsonValue } from '../interfaces/types';
import { RESERVED_FIELDS } from '../interfaces/types';
import type {
  EntityField,
  FieldKind,
  ScalarType,
  ValidationError,
  ValidationRule,
  ValidationRuleType,
} from '../interfaces/schema';

// ── Errors ─────────────────────────────────────────────────

/** The request body is not a usable document (HTTP 400). */
export class InvalidDocumentError extends DataEngineError {
  constructor(message: string) {
    super(message, 'INVALID_DOCUMENT', 400);
    this.name = 'InvalidDocumentError';
  }
}

/** Depth or array-length limit exceeded (HTTP 422). */
export class DocumentLimitError extends DataEngineError {
  constructor(message: string) {
    super(message, 'DOCUMENT_LIMIT_EXCEEDED', 422);
    this.name = 'DocumentLimitError';
  }
}

/** An entity definition (its field list) is malformed (HTTP 400). */
export class EntityDefinitionError extends DataEngineError {
  public readonly errors: ValidationError[];

  constructor(errors: ValidationError[]) {
    super(
      `Invalid entity definition: ${errors.map((e) => (e.path ? `${e.path}: ${e.message}` : e.message)).join('; ')}`,
      'INVALID_ENTITY_DEFINITION',
      400,
    );
    this.name = 'EntityDefinitionError';
    this.errors = errors;
  }
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

// ── Body shape ─────────────────────────────────────────────

/** Throws InvalidDocumentError unless `body` is a JSON object (not an array, not a scalar). */
export function assertDocumentBody(body: unknown, what = 'Document'): asserts body is JsonObject {
  if (Array.isArray(body)) {
    throw new InvalidDocumentError(
      `${what} must be a JSON object, not an array — to insert several documents send the array to POST /data/:entity, which inserts each one`,
    );
  }
  if (!isPlainObject(body)) {
    throw new InvalidDocumentError(`${what} must be a JSON object`);
  }
}

/**
 * Remove the reserved envelope fields (_id, _version, …) from a write body.
 * The envelope is owned by the engine; a client that sends back a document it
 * read must not be able to overwrite it, and must not be rejected for trying.
 */
export function stripEnvelopeFields(doc: JsonObject): JsonObject {
  const out: JsonObject = {};
  for (const [key, value] of Object.entries(doc)) {
    if (!RESERVED_FIELDS.has(key)) out[key] = value;
  }
  return out;
}

// ── Limits ─────────────────────────────────────────────────

export interface DocumentLimits {
  maxDocumentKb: number;
  maxNestingDepth: number;
  maxArrayItems: number;
}

/**
 * Enforce the configured document limits:
 *  - serialized size  > maxDocumentKb   → 413 DOCUMENT_TOO_LARGE
 *  - nesting depth    > maxNestingDepth → 422 DOCUMENT_LIMIT_EXCEEDED
 *  - any array length > maxArrayItems   → 422 DOCUMENT_LIMIT_EXCEEDED
 *
 * Depth counts the objects and arrays below the document root:
 * `{ "a": 1 }` is depth 0, `{ "a": { "b": [1] } }` is depth 2.
 */
export function checkDocumentLimits(doc: JsonObject, limits: DocumentLimits): void {
  const size = Buffer.byteLength(JSON.stringify(doc), 'utf8');
  if (size > limits.maxDocumentKb * 1024) {
    throw new DocumentTooLargeError(Math.ceil(size / 1024), limits.maxDocumentKb);
  }

  const walk = (value: JsonValue, path: string, depth: number): void => {
    if (value === null || typeof value !== 'object') return;
    if (depth > limits.maxNestingDepth) {
      throw new DocumentLimitError(
        `Document nesting depth exceeds the maximum of ${limits.maxNestingDepth} levels at "${path}"`,
      );
    }
    if (Array.isArray(value)) {
      if (value.length > limits.maxArrayItems) {
        throw new DocumentLimitError(
          `Array "${path}" has ${value.length} items; the maximum is ${limits.maxArrayItems}`,
        );
      }
      value.forEach((item, i) => walk(item, `${path}[${i}]`, depth + 1));
      return;
    }
    for (const [key, child] of Object.entries(value)) {
      walk(child, path ? `${path}.${key}` : key, depth + 1);
    }
  };

  for (const [key, value] of Object.entries(doc)) walk(value, key, 1);
}

// ── Schema validation ──────────────────────────────────────

/**
 *  - create / replace: the whole document is checked; required fields must be present.
 *  - patch:            only the fields in the patch are checked (a patch replaces
 *                      each top-level field it names, so a nested object in a patch
 *                      is checked in full); required fields may be omitted but
 *                      not set to null.
 */
export type ValidationMode = 'create' | 'replace' | 'patch';

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const ISO_DATETIME_RE = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PHONE_RE = /^\+?[0-9\s\-().]+$/;
const MAX_ERRORS = 50;

function describe(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'an array';
  if (typeof value === 'object') return 'an object';
  if (typeof value === 'string') return 'a string';
  if (typeof value === 'number') return 'a number';
  if (typeof value === 'boolean') return 'a boolean';
  return typeof value;
}

function isRequired(field: EntityField): boolean {
  return field.required === true || (field.validationRules ?? []).some((r) => r?.type === 'required');
}

class Validator {
  readonly errors: ValidationError[] = [];

  add(path: string, message: string): void {
    if (this.errors.length < MAX_ERRORS) this.errors.push({ path, message });
  }

  fields(doc: Record<string, unknown>, fields: EntityField[], prefix: string, partial: boolean): void {
    for (const field of fields) {
      if (!field || typeof field.name !== 'string' || field.name === '') continue;
      const path = prefix ? `${prefix}.${field.name}` : field.name;
      const value = doc[field.name];

      if (field.kind === 'viewerState') {
        if (value !== undefined) {
          this.add(path, 'is a viewer-state field; it is computed when read and cannot be stored');
        }
        continue;
      }
      if (field.kind === 'computed') continue; // read-only, never validated on write

      if (value === undefined) {
        if (!partial && isRequired(field)) this.add(path, 'is required');
        continue;
      }
      if (value === null) {
        if (isRequired(field)) this.add(path, 'is required and cannot be null');
        continue;
      }
      this.value(value, field, path);
    }
  }

  value(value: unknown, field: EntityField, path: string): void {
    const before = this.errors.length;
    switch (field.kind) {
      case 'scalar':
        this.scalar(value, field.type, path);
        break;
      case 'object':
        if (!isPlainObject(value)) {
          this.add(path, `must be an object, got ${describe(value)}`);
        } else if (field.children?.length) {
          // A nested object is always written whole, so check it in full.
          this.fields(value, field.children, path, false);
        }
        break;
      case 'array':
        if (!Array.isArray(value)) {
          this.add(path, `must be an array, got ${describe(value)}`);
        } else if (field.itemSchema) {
          value.forEach((item, i) => {
            if (item === null || item === undefined) {
              this.add(`${path}[${i}]`, 'must not be null');
            } else {
              this.value(item, field.itemSchema as EntityField, `${path}[${i}]`);
            }
          });
        }
        break;
      case 'lookup':
      case 'relation':
        if (typeof value !== 'string' && typeof value !== 'number') {
          this.add(path, `must be the id of a ${field.lookupEntity ?? 'related'} document (a string), got ${describe(value)}`);
        }
        break;
      case 'attachment':
      case 'media':
      case 'syncState':
        if (!isPlainObject(value)) this.add(path, `must be an object, got ${describe(value)}`);
        break;
      case 'counter':
        if (typeof value !== 'number' || !Number.isFinite(value)) {
          this.add(path, `must be a number, got ${describe(value)}`);
        }
        break;
      case 'localizedText':
        if (!isPlainObject(value)) {
          this.add(path, `must be an object of locale → text, got ${describe(value)}`);
        } else {
          for (const [locale, text] of Object.entries(value)) {
            if (typeof text !== 'string') this.add(`${path}.${locale}`, `must be a string, got ${describe(text)}`);
          }
        }
        break;
      default:
        break; // unknown kinds are not validated
    }
    // Rules only make sense on a value of the right type.
    if (this.errors.length === before) this.rules(value, field.validationRules ?? [], path);
  }

  scalar(value: unknown, type: ScalarType | undefined, path: string): void {
    switch (type) {
      case 'text':
      case 'longText':
        if (typeof value !== 'string') this.add(path, `must be a string, got ${describe(value)}`);
        break;
      case 'phone':
        if (typeof value !== 'string') this.add(path, `must be a string, got ${describe(value)}`);
        else if (!PHONE_RE.test(value)) this.add(path, 'must be a phone number');
        break;
      case 'number':
      case 'currency':
        if (typeof value !== 'number' || !Number.isFinite(value)) {
          this.add(path, `must be a number, got ${describe(value)}`);
        }
        break;
      case 'boolean':
        if (typeof value !== 'boolean') this.add(path, `must be a boolean, got ${describe(value)}`);
        break;
      case 'date':
        if (typeof value !== 'string' || !(ISO_DATE_RE.test(value) || ISO_DATETIME_RE.test(value)) || Number.isNaN(Date.parse(value))) {
          this.add(path, 'must be a date string (YYYY-MM-DD)');
        }
        break;
      case 'datetime':
        if (typeof value !== 'string' || !ISO_DATETIME_RE.test(value) || Number.isNaN(Date.parse(value))) {
          this.add(path, 'must be an ISO 8601 date-time string, e.g. 2026-01-31T09:30:00Z');
        }
        break;
      case 'email':
        if (typeof value !== 'string' || !EMAIL_RE.test(value)) this.add(path, 'must be an email address');
        break;
      case 'url':
        if (typeof value !== 'string' || !/^[a-z][a-z0-9+.-]*:\/\/\S+$/i.test(value)) {
          this.add(path, 'must be an absolute URL, e.g. https://example.com');
        }
        break;
      case 'multiLookup':
        if (!Array.isArray(value) || value.some((v) => typeof v !== 'string')) {
          this.add(path, 'must be an array of document ids (strings)');
        }
        break;
      default:
        break; // 'json' and untyped scalars accept any JSON value
    }
  }

  rules(value: unknown, rules: ValidationRule[], path: string): void {
    for (const rule of rules) {
      if (!rule || typeof rule !== 'object') continue;
      const config = (rule.config ?? {}) as Record<string, unknown>;
      const custom = typeof rule.errorMessage === 'string' && rule.errorMessage ? rule.errorMessage : null;
      const n = typeof config.value === 'number' ? config.value : undefined;
      const length = typeof value === 'string' || Array.isArray(value) ? value.length : undefined;
      switch (rule.type) {
        case 'minLength':
          if (n !== undefined && length !== undefined && length < n) this.add(path, custom ?? `must have at least ${n} characters`);
          break;
        case 'maxLength':
          if (n !== undefined && length !== undefined && length > n) this.add(path, custom ?? `must have at most ${n} characters`);
          break;
        case 'minValue':
          if (n !== undefined && typeof value === 'number' && value < n) this.add(path, custom ?? `must be at least ${n}`);
          break;
        case 'maxValue':
          if (n !== undefined && typeof value === 'number' && value > n) this.add(path, custom ?? `must be at most ${n}`);
          break;
        case 'regex': {
          if (typeof value !== 'string' || typeof config.pattern !== 'string') break;
          let re: RegExp | null = null;
          try {
            re = new RegExp(config.pattern);
          } catch {
            re = null; // an invalid stored pattern never blocks writes
          }
          if (re && !re.test(value)) this.add(path, custom ?? `must match the pattern ${config.pattern}`);
          break;
        }
        case 'email':
          if (typeof value === 'string' && !EMAIL_RE.test(value)) this.add(path, custom ?? 'must be an email address');
          break;
        case 'phone':
          if (typeof value === 'string' && !PHONE_RE.test(value)) this.add(path, custom ?? 'must be a phone number');
          break;
        default:
          break; // required is handled above; lookupExists/customExpression run elsewhere
      }
    }
  }
}

/**
 * Validate a document (or a patch) against an entity's field definitions.
 * Returns the list of violations — empty means valid. Fields that are not in
 * the definition are allowed (documents are schema-flexible beyond the
 * declared fields).
 */
export function validateDocument(
  doc: JsonObject,
  fields: EntityField[] | null | undefined,
  mode: ValidationMode,
): ValidationError[] {
  if (!Array.isArray(fields) || fields.length === 0) return [];
  const v = new Validator();
  v.fields(doc, fields, '', mode === 'patch');
  return v.errors;
}

// ── Entity definitions ─────────────────────────────────────

const FIELD_KINDS: ReadonlySet<FieldKind> = new Set<FieldKind>([
  'scalar', 'object', 'array', 'lookup', 'attachment', 'media', 'relation',
  'computed', 'counter', 'localizedText', 'viewerState', 'syncState',
]);
const SCALAR_TYPES: ReadonlySet<ScalarType> = new Set<ScalarType>([
  'text', 'longText', 'number', 'currency', 'boolean', 'date', 'datetime',
  'email', 'phone', 'url', 'json', 'multiLookup',
]);
const RULE_TYPES: ReadonlySet<ValidationRuleType> = new Set<ValidationRuleType>([
  'required', 'minLength', 'maxLength', 'regex', 'email', 'phone',
  'minValue', 'maxValue', 'lookupExists', 'customExpression',
]);
const FIELD_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const MAX_FIELDS_PER_LEVEL = 500;

/**
 * Validate and normalise an untrusted field list for an entity definition:
 * defaults are filled in (`required`/`unique`/`indexed` false, `validationRules`
 * [], `displayName` = name, a stable `id`), so every stored definition has the
 * same shape. Throws EntityDefinitionError (400) listing every problem.
 */
export function normalizeEntityFields(
  raw: unknown,
  options?: { maxNestingDepth?: number },
): EntityField[] {
  if (raw === undefined || raw === null) return [];
  const errors: ValidationError[] = [];
  if (!Array.isArray(raw)) {
    throw new EntityDefinitionError([{ path: 'fields', message: 'must be an array of field definitions' }]);
  }
  const maxDepth = options?.maxNestingDepth ?? 8;

  const normalizeField = (input: unknown, path: string, parentLabel: string, depth: number, topLevel: boolean, nameOptional: boolean): EntityField | null => {
    if (!isPlainObject(input)) {
      errors.push({ path, message: 'must be an object like { "name": "title", "kind": "scalar", "type": "text" }' });
      return null;
    }
    const name = input.name === undefined && nameOptional ? 'item' : input.name;
    if (typeof name !== 'string' || !FIELD_NAME_RE.test(name) || name.length > 64) {
      errors.push({ path: `${path}.name`, message: 'must be an identifier (letters, digits, underscore; not starting with a digit; max 64 characters)' });
      return null;
    }
    const label = nameOptional ? path : `${parentLabel}.${name}`;
    if (topLevel && (RESERVED_FIELDS.has(name) || name.startsWith('_'))) {
      errors.push({ path: label, message: 'field names starting with "_" are reserved for the document envelope' });
      return null;
    }
    const kind = (input.kind ?? 'scalar') as FieldKind;
    if (!FIELD_KINDS.has(kind)) {
      errors.push({ path: `${label}.kind`, message: `must be one of ${[...FIELD_KINDS].join(', ')}` });
      return null;
    }
    const type = input.type as ScalarType | undefined;
    if (type !== undefined && !SCALAR_TYPES.has(type)) {
      errors.push({ path: `${label}.type`, message: `must be one of ${[...SCALAR_TYPES].join(', ')}` });
    }
    if (depth > maxDepth) {
      errors.push({ path: label, message: `nesting exceeds the maximum of ${maxDepth} levels` });
      return null;
    }

    const rulesIn = input.validationRules ?? [];
    const validationRules: ValidationRule[] = [];
    if (!Array.isArray(rulesIn)) {
      errors.push({ path: `${label}.validationRules`, message: 'must be an array' });
    } else {
      rulesIn.forEach((rule, i) => {
        if (!isPlainObject(rule) || !RULE_TYPES.has(rule.type as ValidationRuleType)) {
          errors.push({ path: `${label}.validationRules[${i}]`, message: `must be { "type": one of ${[...RULE_TYPES].join(', ')}, "config": { … } }` });
          return;
        }
        if (rule.type === 'regex' && isPlainObject(rule.config) && typeof rule.config.pattern === 'string') {
          try {
            new RegExp(rule.config.pattern);
          } catch {
            errors.push({ path: `${label}.validationRules[${i}]`, message: 'has an invalid regular expression' });
          }
        }
        validationRules.push({
          id: typeof rule.id === 'string' ? rule.id : `${label}.rule${i}`,
          type: rule.type as ValidationRuleType,
          config: (isPlainObject(rule.config) ? rule.config : {}) as JsonObject,
          ...(typeof rule.errorMessage === 'string' ? { errorMessage: rule.errorMessage } : {}),
        });
      });
    }

    const field: EntityField = {
      ...(input as unknown as EntityField),
      id: typeof input.id === 'string' && input.id ? input.id : label,
      name,
      displayName: typeof input.displayName === 'string' && input.displayName ? input.displayName : name,
      kind,
      ...(type !== undefined ? { type } : {}),
      required: input.required === true,
      unique: input.unique === true,
      indexed: input.indexed === true,
      validationRules,
    };

    if (kind === 'object') {
      if (input.children !== undefined && !Array.isArray(input.children)) {
        errors.push({ path: `${label}.children`, message: 'must be an array of field definitions' });
      } else {
        field.children = normalizeList(input.children as unknown[] | undefined, label, depth + 1, false);
      }
    } else {
      delete field.children;
    }
    if (kind === 'array') {
      if (input.itemSchema !== undefined) {
        const item = normalizeField(input.itemSchema, `${label}.itemSchema`, label, depth + 1, false, true);
        if (item) field.itemSchema = item;
      }
    } else {
      delete field.itemSchema;
    }
    return field;
  };

  const normalizeList = (list: unknown[] | undefined, parent: string, depth: number, topLevel: boolean): EntityField[] => {
    if (!list) return [];
    if (list.length > MAX_FIELDS_PER_LEVEL) {
      errors.push({ path: parent, message: `has more than ${MAX_FIELDS_PER_LEVEL} fields` });
      return [];
    }
    const seen = new Set<string>();
    const out: EntityField[] = [];
    list.forEach((item, i) => {
      const field = normalizeField(item, `${parent}[${i}]`, parent, depth, topLevel, false);
      if (!field) return;
      if (seen.has(field.name)) {
        errors.push({ path: `${parent}.${field.name}`, message: 'is defined more than once' });
        return;
      }
      seen.add(field.name);
      out.push(field);
    });
    return out;
  };

  const fields = normalizeList(raw, 'fields', 0, true);
  if (errors.length > 0) throw new EntityDefinitionError(errors.slice(0, MAX_ERRORS));
  return fields;
}
