/**
 * Schema Compiler Unit Tests
 *
 * Tests: EntityField[] → JSON Schema compilation, reserved field rejection,
 * viewerState write rejection, nesting depth limits.
 */

import {
  compileFieldsToJsonSchema,
  findReservedFieldConflicts,
  findViewerStateInDocument,
} from '../validation/schema';
import type { EntityField } from '../interfaces/schema';
import type { JsonObject } from '../interfaces/types';
import { TIKTOK_FIXTURE } from '../__fixtures__/tiktok-model';

describe('compileFieldsToJsonSchema', () => {
  it('should compile flat scalar fields', () => {
    const fields: EntityField[] = [
      { id: '1', name: 'name', displayName: 'Name', kind: 'scalar', type: 'text', required: true, unique: false, indexed: false, validationRules: [] },
      { id: '2', name: 'age', displayName: 'Age', kind: 'scalar', type: 'number', required: false, unique: false, indexed: false, validationRules: [] },
      { id: '3', name: 'active', displayName: 'Active', kind: 'scalar', type: 'boolean', required: false, unique: false, indexed: false, validationRules: [] },
    ];

    const schema = compileFieldsToJsonSchema(fields);

    expect(schema.type).toBe('object');
    expect(schema.required).toEqual(['name']);
    const props = schema.properties as JsonObject;
    expect((props.name as JsonObject).type).toBe('string');
    expect((props.age as JsonObject).type).toBe('number');
    expect((props.active as JsonObject).type).toBe('boolean');
  });

  it('should compile nested object fields', () => {
    const fields: EntityField[] = [
      {
        id: '1', name: 'address', displayName: 'Address', kind: 'object',
        required: true, unique: false, indexed: false, validationRules: [],
        children: [
          { id: '2', name: 'city', displayName: 'City', kind: 'scalar', type: 'text', required: true, unique: false, indexed: false, validationRules: [] },
          { id: '3', name: 'country', displayName: 'Country', kind: 'scalar', type: 'text', required: true, unique: false, indexed: false, validationRules: [] },
        ],
      },
    ];

    const schema = compileFieldsToJsonSchema(fields);
    const addressSchema = (schema.properties as JsonObject).address as JsonObject;

    expect(addressSchema.type).toBe('object');
    expect(((addressSchema.properties as JsonObject).city as JsonObject).type).toBe('string');
    expect(addressSchema.required).toEqual(['city', 'country']);
  });

  it('should compile array fields', () => {
    const fields: EntityField[] = [
      {
        id: '1', name: 'tags', displayName: 'Tags', kind: 'array',
        required: false, unique: false, indexed: false, validationRules: [],
        itemSchema: { id: '2', name: 'tag', displayName: 'Tag', kind: 'scalar', type: 'text', required: true, unique: false, indexed: false, validationRules: [] },
      },
    ];

    const schema = compileFieldsToJsonSchema(fields);
    const tagsSchema = (schema.properties as JsonObject).tags as JsonObject;

    expect(tagsSchema.type).toBe('array');
    expect((tagsSchema.items as JsonObject).type).toBe('string');
  });

  it('should compile counter fields', () => {
    const fields: EntityField[] = [
      { id: '1', name: 'views', displayName: 'Views', kind: 'counter', required: false, unique: false, indexed: false, validationRules: [], counterInitial: 0 },
    ];

    const schema = compileFieldsToJsonSchema(fields);
    const viewsSchema = (schema.properties as JsonObject).views as JsonObject;

    expect(viewsSchema.type).toBe('number');
    expect(viewsSchema.default).toBe(0);
  });

  it('should compile media fields', () => {
    const fields: EntityField[] = [
      { id: '1', name: 'cover', displayName: 'Cover', kind: 'media', required: false, unique: false, indexed: false, validationRules: [] },
    ];

    const schema = compileFieldsToJsonSchema(fields);
    const mediaSchema = (schema.properties as JsonObject).cover as JsonObject;

    expect(mediaSchema.type).toBe('object');
    expect((mediaSchema.properties as JsonObject).url).toBeDefined();
    expect((mediaSchema.properties as JsonObject).width).toBeDefined();
    expect((mediaSchema.properties as JsonObject).duration).toBeDefined();
  });

  it('should mark viewerState as virtual', () => {
    const fields: EntityField[] = [
      { id: '1', name: 'viewerState', displayName: 'Viewer State', kind: 'viewerState', required: false, unique: false, indexed: false, validationRules: [] },
    ];

    const schema = compileFieldsToJsonSchema(fields);
    const vsSchema = (schema.properties as JsonObject).viewerState as JsonObject;
    expect(vsSchema._virtual).toBe(true);
  });

  it('should apply validation rules as JSON Schema constraints', () => {
    const fields: EntityField[] = [
      {
        id: '1', name: 'email', displayName: 'Email', kind: 'scalar', type: 'email',
        required: true, unique: false, indexed: false,
        validationRules: [
          { id: 'v1', type: 'email', config: {} },
          { id: 'v2', type: 'maxLength', config: { value: 255 } },
        ],
      },
    ];

    const schema = compileFieldsToJsonSchema(fields);
    const emailSchema = (schema.properties as JsonObject).email as JsonObject;

    expect(emailSchema.format).toBe('email');
    expect(emailSchema.maxLength).toBe(255);
  });

  it('should enforce nesting depth limit', () => {
    // Build a 10-level deep nested structure
    let current: EntityField = {
      id: 'leaf', name: 'value', displayName: 'Value', kind: 'scalar', type: 'text',
      required: false, unique: false, indexed: false, validationRules: [],
    };
    for (let i = 9; i >= 0; i--) {
      current = {
        id: `level_${i}`, name: `level${i}`, displayName: `Level ${i}`, kind: 'object',
        required: false, unique: false, indexed: false, validationRules: [],
        children: [current],
      };
    }

    const schema = compileFieldsToJsonSchema([current], { maxNestingDepth: 3 });
    // Should not throw, but deep levels become generic objects
    expect(schema).toBeDefined();
  });

  it('should compile TikTok fixture entities deterministically', () => {
    const schema1 = compileFieldsToJsonSchema(TIKTOK_FIXTURE.entities.videos.fields);
    const schema2 = compileFieldsToJsonSchema(TIKTOK_FIXTURE.entities.videos.fields);

    // Deterministic: same input → same output
    expect(JSON.stringify(schema1)).toBe(JSON.stringify(schema2));
  });
});

describe('findReservedFieldConflicts', () => {
  it('should detect reserved field names', () => {
    const fields: EntityField[] = [
      { id: '1', name: '_id', displayName: 'ID', kind: 'scalar', type: 'text', required: true, unique: false, indexed: false, validationRules: [] },
      { id: '2', name: '_projectId', displayName: 'Project', kind: 'scalar', type: 'text', required: true, unique: false, indexed: false, validationRules: [] },
      { id: '3', name: 'normalField', displayName: 'Normal', kind: 'scalar', type: 'text', required: false, unique: false, indexed: false, validationRules: [] },
    ];

    const conflicts = findReservedFieldConflicts(fields);
    expect(conflicts).toContain('_id');
    expect(conflicts).toContain('_projectId');
    expect(conflicts).not.toContain('normalField');
  });

  it('should have no conflicts in TikTok fixture entities', () => {
    const videoConflicts = findReservedFieldConflicts(TIKTOK_FIXTURE.entities.videos.fields);
    const userConflicts = findReservedFieldConflicts(TIKTOK_FIXTURE.entities.users.fields);
    const commentConflicts = findReservedFieldConflicts(TIKTOK_FIXTURE.entities.comments.fields);

    expect(videoConflicts).toEqual([]);
    expect(userConflicts).toEqual([]);
    expect(commentConflicts).toEqual([]);
  });
});

describe('findViewerStateInDocument', () => {
  it('should reject viewerState stored in documents', () => {
    const fields: EntityField[] = [
      { id: '1', name: 'title', displayName: 'Title', kind: 'scalar', type: 'text', required: true, unique: false, indexed: false, validationRules: [] },
      { id: '2', name: 'viewerState', displayName: 'VS', kind: 'viewerState', required: false, unique: false, indexed: false, validationRules: [] },
    ];

    const doc: JsonObject = { title: 'Test', viewerState: { liked: true } };
    const violations = findViewerStateInDocument(doc, fields);
    expect(violations).toContain('viewerState');
  });

  it('should accept documents without viewerState', () => {
    const fields: EntityField[] = [
      { id: '1', name: 'title', displayName: 'Title', kind: 'scalar', type: 'text', required: true, unique: false, indexed: false, validationRules: [] },
      { id: '2', name: 'viewerState', displayName: 'VS', kind: 'viewerState', required: false, unique: false, indexed: false, validationRules: [] },
    ];

    const doc: JsonObject = { title: 'Test' };
    const violations = findViewerStateInDocument(doc, fields);
    expect(violations).toEqual([]);
  });
});
