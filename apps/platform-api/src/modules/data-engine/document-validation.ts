import { BadRequestException, PayloadTooLargeException } from '@nestjs/common';

export const MAX_DOCUMENT_BYTES = 1024 * 1024;
export const MAX_ARRAY_ITEMS = 1000;
export const MAX_NESTING_DEPTH = 8;

type Field = {
  name: string;
  kind?: string;
  type?: string;
  required?: boolean;
  children?: Field[];
  itemSchema?: Field;
};

const STRING_TYPES = new Set(['text', 'longText', 'email', 'phone', 'url', 'date', 'datetime']);
const NUMBER_TYPES = new Set(['number', 'currency']);

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function checkShape(value: unknown, depth: number): void {
  if (depth > MAX_NESTING_DEPTH) {
    throw new BadRequestException(`Document nesting exceeds ${MAX_NESTING_DEPTH} levels`);
  }
  if (Array.isArray(value)) {
    if (value.length > MAX_ARRAY_ITEMS) {
      throw new BadRequestException(`Arrays are limited to ${MAX_ARRAY_ITEMS} items`);
    }
    for (const v of value) checkShape(v, depth + 1);
  } else if (isObject(value)) {
    for (const v of Object.values(value)) checkShape(v, depth + 1);
  }
}

function checkFields(doc: Record<string, unknown>, fields: Field[], partial: boolean, prefix: string, errors: string[]): void {
  for (const f of fields) {
    const path = prefix ? `${prefix}.${f.name}` : f.name;
    const v = doc[f.name];
    if ((v === undefined || v === null) && f.kind === 'object' && f.children?.some((c) => c.required) && !partial) {
      checkFields({}, f.children, false, path, errors);
      continue;
    }
    if (v === undefined || v === null) {
      if (f.required && !partial && f.kind !== 'computed' && f.kind !== 'counter' && f.kind !== 'viewerState') {
        errors.push(`"${path}" is required`);
      }
      if (v === null && f.required && partial) errors.push(`"${path}" is required and cannot be null`);
      continue;
    }
    if (f.kind === 'scalar' || (!f.kind && f.type)) {
      if (STRING_TYPES.has(f.type ?? '') && typeof v !== 'string') errors.push(`"${path}" must be a string`);
      else if (NUMBER_TYPES.has(f.type ?? '') && (typeof v !== 'number' || !Number.isFinite(v))) errors.push(`"${path}" must be a number`);
      else if (f.type === 'boolean' && typeof v !== 'boolean') errors.push(`"${path}" must be a boolean`);
      else if (f.type === 'multiLookup' && !Array.isArray(v)) errors.push(`"${path}" must be an array`);
    } else if (f.kind === 'object') {
      if (!isObject(v)) errors.push(`"${path}" must be an object`);
      else if (f.children?.length) checkFields(v, f.children, partial, path, errors);
    } else if (f.kind === 'array') {
      if (!Array.isArray(v)) errors.push(`"${path}" must be an array`);
    }
  }
}

/**
 * Validate a document before a write: it must be a plain object (not an array),
 * within the size, array and nesting limits, and match the entity's declared
 * fields (required fields and scalar types). `partial` (PATCH) skips the
 * required-field check for fields that are absent.
 */
export function validateDocument(body: unknown, fields: unknown, opts: { partial?: boolean } = {}): void {
  if (!isObject(body)) {
    throw new BadRequestException('Request body must be a JSON object');
  }
  if (Buffer.byteLength(JSON.stringify(body), 'utf8') > MAX_DOCUMENT_BYTES) {
    throw new PayloadTooLargeException(`Document exceeds the ${MAX_DOCUMENT_BYTES / 1024 / 1024} MB limit`);
  }
  checkShape(body, 1);
  if (Array.isArray(fields) && fields.length) {
    const errors: string[] = [];
    checkFields(body, fields as Field[], !!opts.partial, '', errors);
    if (errors.length) {
      throw new BadRequestException({ message: `Validation failed: ${errors.join('; ')}`, errors });
    }
  }
}
