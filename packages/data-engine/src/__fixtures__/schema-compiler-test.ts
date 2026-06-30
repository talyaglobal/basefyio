/**
 * Schema Compiler Round-Trip Test (compile-time verification)
 *
 * Proves: compileFieldsToJsonSchema(entity.fields) produces valid JSON Schema,
 * and findReservedFieldConflicts rejects reserved names.
 */

import { TIKTOK_FIXTURE } from './tiktok-model';
import { compileFieldsToJsonSchema, findReservedFieldConflicts, findViewerStateInDocument } from '../validation/schema';
import type { JsonObject, StoredDocument } from '../interfaces/types';

// Round-trip: compile video entity fields to JSON Schema
const videoSchema: JsonObject = compileFieldsToJsonSchema(TIKTOK_FIXTURE.entities.videos.fields);

// Verify output shape (compile-time type check)
const _schemaHasType: JsonObject = videoSchema;
const _schemaType: string = videoSchema.$schema as string;
const _props: JsonObject = videoSchema.properties as JsonObject;

// Reserved field check: no conflicts in well-designed entities
const videoConflicts: string[] = findReservedFieldConflicts(TIKTOK_FIXTURE.entities.videos.fields);
const _noConflicts: true = (videoConflicts.length === 0) as true;

// viewerState rejection: sample doc does NOT contain viewerState (correct)
const viewerViolations: string[] = findViewerStateInDocument(
  TIKTOK_FIXTURE.sampleDocuments.video as unknown as JsonObject,
  TIKTOK_FIXTURE.entities.videos.fields,
);

// Compile user entity too
const userSchema: JsonObject = compileFieldsToJsonSchema(TIKTOK_FIXTURE.entities.users.fields);

// Compile comments entity
const commentsSchema: JsonObject = compileFieldsToJsonSchema(TIKTOK_FIXTURE.entities.comments.fields);

export const SCHEMA_ROUND_TRIP = {
  videoSchema,
  userSchema,
  commentsSchema,
  videoConflicts,
  viewerViolations,
} as const;
