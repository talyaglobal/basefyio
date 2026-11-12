import {
  assertDocumentBody,
  checkDocumentLimits,
  normalizeEntityFields,
  stripEnvelopeFields,
  validateDocument,
} from '../validation/document';
import { compileFieldsToJsonSchema } from '../validation/schema';
import type { EntityField } from '../interfaces/schema';

/** The QA entity: firstName/lastName required, address.city required, age number, tags text[]. */
const fields: EntityField[] = normalizeEntityFields([
  { name: 'firstName', kind: 'scalar', type: 'text', required: true },
  { name: 'lastName', kind: 'scalar', type: 'text', required: true },
  {
    name: 'address',
    kind: 'object',
    children: [
      { name: 'city', kind: 'scalar', type: 'text', required: true },
      { name: 'country', kind: 'scalar', type: 'text' },
    ],
  },
  { name: 'age', kind: 'scalar', type: 'number' },
  { name: 'tags', kind: 'array', itemSchema: { name: 'tag', kind: 'scalar', type: 'text' } },
  { name: 'email', kind: 'scalar', type: 'email', validationRules: [{ type: 'maxLength', config: { value: 40 } }] },
]);

const valid = { firstName: 'A', lastName: 'B', address: { city: 'Ankara' }, age: 30, tags: ['x'] };

describe('validateDocument', () => {
  it('accepts a valid document and extra undeclared fields', () => {
    expect(validateDocument({ ...valid, extra: { anything: true } }, fields, 'create')).toEqual([]);
  });

  it('reports missing required fields on create', () => {
    expect(validateDocument({ firstName: 'X' }, fields, 'create')).toEqual([
      { path: 'lastName', message: 'is required' },
    ]);
    expect(validateDocument({}, fields, 'create').map((e) => e.path)).toEqual(['firstName', 'lastName']);
  });

  it('checks nested required fields when the object is present', () => {
    expect(validateDocument({ ...valid, address: { country: 'TR' } }, fields, 'create')).toEqual([
      { path: 'address.city', message: 'is required' },
    ]);
  });

  it('reports wrong types', () => {
    const errors = validateDocument({ ...valid, age: 'otuz', tags: 'notarray' }, fields, 'create');
    expect(errors).toEqual([
      { path: 'age', message: 'must be a number, got a string' },
      { path: 'tags', message: 'must be an array, got a string' },
    ]);
  });

  it('validates array items', () => {
    expect(validateDocument({ ...valid, tags: ['ok', 5] }, fields, 'create')).toEqual([
      { path: 'tags[1]', message: 'must be a string, got a number' },
    ]);
  });

  it('applies validation rules', () => {
    expect(validateDocument({ ...valid, email: 'not-an-email' }, fields, 'create')[0]).toEqual({
      path: 'email',
      message: 'must be an email address',
    });
    expect(validateDocument({ ...valid, email: `${'a'.repeat(40)}@x.io` }, fields, 'create')[0].message).toMatch(/at most 40/);
  });

  it('patch mode only checks the fields present, but rejects nulling a required field', () => {
    expect(validateDocument({ age: 31 }, fields, 'patch')).toEqual([]);
    expect(validateDocument({ age: 'x' }, fields, 'patch')).toHaveLength(1);
    expect(validateDocument({ firstName: null }, fields, 'patch')).toEqual([
      { path: 'firstName', message: 'is required and cannot be null' },
    ]);
    // A nested object in a patch replaces the whole object, so it is checked in full.
    expect(validateDocument({ address: { country: 'TR' } }, fields, 'patch')).toEqual([
      { path: 'address.city', message: 'is required' },
    ]);
  });

  it('accepts anything for an entity without fields (schema-less)', () => {
    expect(validateDocument({ whatever: [1, { a: 2 }] }, [], 'create')).toEqual([]);
  });

  it('tolerates stored definitions that predate normalisation (no validationRules)', () => {
    const legacy = [{ name: 'n', kind: 'scalar', type: 'number', required: true }] as unknown as EntityField[];
    expect(validateDocument({ n: 'x' }, legacy, 'create')).toEqual([{ path: 'n', message: 'must be a number, got a string' }]);
  });
});

describe('assertDocumentBody / stripEnvelopeFields', () => {
  it('rejects arrays and scalars', () => {
    expect(() => assertDocumentBody([{ a: 1 }])).toThrow(/not an array/);
    expect(() => assertDocumentBody('x')).toThrow(/must be a JSON object/);
    expect(() => assertDocumentBody(null)).toThrow(/must be a JSON object/);
    expect(() => assertDocumentBody({ a: 1 })).not.toThrow();
  });

  it('drops envelope fields from write bodies', () => {
    expect(stripEnvelopeFields({ _id: 'x', _version: 3, name: 'n', _custom: 1 })).toEqual({ name: 'n', _custom: 1 });
  });
});

describe('checkDocumentLimits', () => {
  const limits = { maxDocumentKb: 1, maxNestingDepth: 3, maxArrayItems: 5 };

  it('rejects oversized documents with 413', () => {
    expect(() => checkDocumentLimits({ blob: 'x'.repeat(2000) }, limits)).toThrow(
      expect.objectContaining({ code: 'DOCUMENT_TOO_LARGE', statusCode: 413 }),
    );
  });

  it('rejects arrays longer than the limit with 422', () => {
    expect(() => checkDocumentLimits({ tags: [1, 2, 3, 4, 5, 6] }, limits)).toThrow(
      expect.objectContaining({ code: 'DOCUMENT_LIMIT_EXCEEDED', statusCode: 422 }),
    );
    expect(() => checkDocumentLimits({ tags: [1, 2, 3, 4, 5] }, limits)).not.toThrow();
  });

  it('rejects documents nested deeper than the limit with 422', () => {
    // a, b and c are three nested objects: exactly the limit.
    expect(() => checkDocumentLimits({ a: { b: { c: { d: 1 } } } }, limits)).not.toThrow();
    expect(() => checkDocumentLimits({ a: { b: { c: { d: { e: 1 } } } } }, limits)).toThrow(/at "a.b.c.d"/);
    expect(() => checkDocumentLimits({ a: [[[[1]]]] }, limits)).toThrow(/nesting depth/);
  });
});

describe('normalizeEntityFields', () => {
  it('fills defaults so the schema compiler never sees partial fields', () => {
    const [f] = normalizeEntityFields([{ name: 'title', kind: 'scalar', type: 'text' }]);
    expect(f).toMatchObject({ name: 'title', displayName: 'title', required: false, unique: false, indexed: false, validationRules: [] });
    expect(() => compileFieldsToJsonSchema(fields)).not.toThrow();
  });

  it('treats missing fields as an empty list', () => {
    expect(normalizeEntityFields(undefined)).toEqual([]);
  });

  it.each([
    ['a non-array', { name: 'x' }, /must be an array/],
    ['a missing name', [{ kind: 'scalar' }], /must be an identifier/],
    ['a reserved name', [{ name: '_id', kind: 'scalar' }], /reserved/],
    ['an unknown kind', [{ name: 'x', kind: 'blob' }], /kind/],
    ['an unknown type', [{ name: 'x', kind: 'scalar', type: 'int' }], /type/],
    ['a duplicate name', [{ name: 'x' }, { name: 'x' }], /more than once/],
    ['a bad rule', [{ name: 'x', validationRules: [{ type: 'nope' }] }], /validationRules\[0\]/],
  ])('rejects %s', (_label, input, message) => {
    expect(() => normalizeEntityFields(input)).toThrow(expect.objectContaining({ code: 'INVALID_ENTITY_DEFINITION', statusCode: 400 }));
    expect(() => normalizeEntityFields(input)).toThrow(message);
  });

  it('names nested paths in errors', () => {
    expect(() =>
      normalizeEntityFields([{ name: 'address', kind: 'object', children: [{ name: 'city', kind: 'scalar', type: 'bad' }] }]),
    ).toThrow(/fields\.address\.city\.type/);
  });
});
