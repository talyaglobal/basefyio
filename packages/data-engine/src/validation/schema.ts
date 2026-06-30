/**
 * basefyio Data Engine — Schema Compiler & Validator
 *
 * Compiles EntityField[] definitions into JSON Schema.
 * The JSON Schema is the compiled output, never hand-edited.
 * The compiler is deterministic: compile(fields) always produces the same snapshot.
 */

import type { EntityField, ValidationRule, EntityRule, ValidationResult, ValidationError } from '../interfaces/schema';
import type { JsonObject, JsonValue, RESERVED_FIELDS } from '../interfaces/types';

// ── JSON Schema Compiler ───────────────────────────────────

/**
 * Compile an array of EntityField definitions into a JSON Schema object.
 * This is deterministic — the same input always produces the same output.
 */
export function compileFieldsToJsonSchema(
  fields: EntityField[],
  options?: { maxNestingDepth?: number },
): JsonObject {
  const maxDepth = options?.maxNestingDepth ?? 8;

  const schema: JsonObject = {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    type: 'object',
    properties: compileProperties(fields, 0, maxDepth),
    required: fields.filter((f) => f.required).map((f) => f.name),
    additionalProperties: true,
  };

  return schema;
}

function compileProperties(
  fields: EntityField[],
  depth: number,
  maxDepth: number,
): JsonObject {
  const properties: JsonObject = {};

  for (const field of fields) {
    if (depth >= maxDepth) {
      // At max depth, treat everything as generic JSON
      properties[field.name] = { type: 'object' } as JsonValue;
      continue;
    }

    properties[field.name] = compileField(field, depth, maxDepth);
  }

  return properties;
}

function compileField(field: EntityField, depth: number, maxDepth: number): JsonObject {
  const schema: JsonObject = {};

  switch (field.kind) {
    case 'scalar':
      Object.assign(schema, compileScalarType(field));
      break;

    case 'object':
      schema.type = 'object';
      if (field.children && field.children.length > 0) {
        schema.properties = compileProperties(field.children, depth + 1, maxDepth);
        schema.required = field.children
          .filter((c) => c.required)
          .map((c) => c.name) as JsonValue;
      }
      break;

    case 'array':
      schema.type = 'array';
      if (field.itemSchema) {
        schema.items = compileField(field.itemSchema, depth + 1, maxDepth);
      }
      break;

    case 'lookup':
    case 'relation':
      schema.type = 'string';
      schema.description = `Reference to ${field.lookupEntity ?? 'unknown'} entity`;
      break;

    case 'attachment':
    case 'media':
      schema.type = 'object';
      schema.properties = {
        url: { type: 'string', format: 'uri' },
        mimeType: { type: 'string' },
        size: { type: 'number' },
      } as JsonValue;
      if (field.kind === 'media') {
        (schema.properties as JsonObject).width = { type: 'number' } as JsonValue;
        (schema.properties as JsonObject).height = { type: 'number' } as JsonValue;
        (schema.properties as JsonObject).duration = { type: 'number' } as JsonValue;
        (schema.properties as JsonObject).aspectRatio = { type: 'string' } as JsonValue;
      }
      break;

    case 'computed':
      // Read-only; no validation needed on write.
      schema.description = `Computed field: ${field.computeExpression ?? ''}`;
      break;

    case 'counter':
      schema.type = 'number';
      schema.default = field.counterInitial ?? 0;
      schema.description = 'Counter field — updated via events, not document rewrites';
      break;

    case 'localizedText':
      schema.type = 'object';
      schema.description = 'Localized text — keys are locale codes';
      schema.additionalProperties = { type: 'string' } as JsonValue;
      break;

    case 'viewerState':
      // Virtual field — must NOT be stored in documents.
      // The validator rejects this at write time; it exists only in projections.
      schema.description = 'Virtual viewer state — resolved at projection time, never stored';
      schema._virtual = true as JsonValue;
      break;

    case 'syncState':
      schema.type = 'object';
      schema.properties = {
        lastSyncedVersion: { type: 'number' },
        lastSyncedAt: { type: 'string', format: 'date-time' },
        conflictResolution: { type: 'string', enum: ['client-wins', 'server-wins', 'manual'] },
      } as JsonValue;
      break;
  }

  // Apply validation rules as JSON Schema constraints
  for (const rule of field.validationRules) {
    applyValidationRule(schema, rule);
  }

  if (field.displayName) {
    schema.title = field.displayName;
  }

  return schema;
}

function compileScalarType(field: EntityField): JsonObject {
  switch (field.type) {
    case 'text':
    case 'longText':
      return { type: 'string' };
    case 'number':
    case 'currency':
      return { type: 'number' };
    case 'boolean':
      return { type: 'boolean' };
    case 'date':
      return { type: 'string', format: 'date' };
    case 'datetime':
      return { type: 'string', format: 'date-time' };
    case 'email':
      return { type: 'string', format: 'email' };
    case 'phone':
      return { type: 'string' };
    case 'url':
      return { type: 'string', format: 'uri' };
    case 'json':
      return {};
    case 'multiLookup':
      return { type: 'array', items: { type: 'string' } };
    default:
      return { type: 'string' };
  }
}

function applyValidationRule(schema: JsonObject, rule: ValidationRule): void {
  const config = rule.config;
  switch (rule.type) {
    case 'minLength':
      schema.minLength = config.value as JsonValue;
      break;
    case 'maxLength':
      schema.maxLength = config.value as JsonValue;
      break;
    case 'regex':
      schema.pattern = config.pattern as JsonValue;
      break;
    case 'minValue':
      schema.minimum = config.value as JsonValue;
      break;
    case 'maxValue':
      schema.maximum = config.value as JsonValue;
      break;
    case 'email':
      schema.format = 'email';
      break;
    case 'phone':
      schema.pattern = config.pattern as JsonValue ?? '^\\+?[0-9\\s\\-().]+$';
      break;
    // required, lookupExists, customExpression handled by the validation pipeline, not JSON Schema
  }
}

// ── Reserved Field Checker ─────────────────────────────────

import { RESERVED_FIELDS as RESERVED } from '../interfaces/types';

/**
 * Validate that no EntityField uses a reserved name.
 * Returns field names that conflict.
 */
export function findReservedFieldConflicts(fields: EntityField[]): string[] {
  const conflicts: string[] = [];

  function check(fieldList: EntityField[], prefix: string) {
    for (const f of fieldList) {
      const fullPath = prefix ? `${prefix}.${f.name}` : f.name;
      // Only top-level fields conflict with reserved names
      if (!prefix && RESERVED.has(f.name)) {
        conflicts.push(f.name);
      }
      if (f.children) check(f.children, fullPath);
    }
  }

  check(fields, '');
  return conflicts;
}

// ── viewerState Write Rejection ────────────────────────────

/**
 * Check that a document being written does not contain viewerState fields.
 * viewerState is virtual — computed at projection time, never stored.
 */
export function findViewerStateInDocument(
  doc: JsonObject,
  fields: EntityField[],
  prefix = '',
): string[] {
  const violations: string[] = [];

  for (const field of fields) {
    const path = prefix ? `${prefix}.${field.name}` : field.name;
    if (field.kind === 'viewerState' && doc[field.name] !== undefined) {
      violations.push(path);
    }
    if (field.kind === 'object' && field.children && typeof doc[field.name] === 'object' && doc[field.name] !== null) {
      violations.push(
        ...findViewerStateInDocument(doc[field.name] as JsonObject, field.children, path),
      );
    }
  }

  return violations;
}
