/**
 * MongoDB translation layer tests — pure AST → native Mongo mapping.
 * No driver required; validates the same contract the live engine executes.
 */

import {
  aggregationToMongoPipeline,
  filterToMongo,
  likeToRegexSource,
  selectToMongo,
  sortToMongo,
  toStoredPath,
} from '../providers/mongodb/mongo-translate';
import { validateAggregation } from '../query/aggregation-validator';
import { parseJsQuery } from '../query/js-query-parser';
import type { Filter } from '../interfaces/query';

const field = (
  path: string,
  operator: Filter extends { operator: infer O } ? O : never | string,
  value: unknown,
): Filter =>
  ({
    type: 'field',
    path: { path, isArrayPath: path.includes('[]') },
    operator,
    value,
  }) as Filter;

describe('toStoredPath', () => {
  it('prefixes user paths with data.', () => {
    expect(toStoredPath('status')).toBe('data.status');
    expect(toStoredPath('customer.address.city')).toBe('data.customer.address.city');
  });

  it('maps envelope paths to envelope fields', () => {
    expect(toStoredPath('_createdAt')).toBe('envelope.createdAt');
    expect(toStoredPath('_status')).toBe('envelope.status');
    expect(toStoredPath('_id')).toBe('_id');
  });

  it('drops [] array markers (Mongo traverses arrays implicitly)', () => {
    expect(toStoredPath('items[].sku')).toBe('data.items.sku');
  });

  it('uses raw paths after reshape', () => {
    expect(toStoredPath('revenue', { reshaped: true })).toBe('revenue');
    expect(toStoredPath('_createdAt', { reshaped: true })).toBe('_createdAt');
  });
});

describe('likeToRegexSource', () => {
  it('translates % and _ wildcards and anchors the pattern', () => {
    expect(likeToRegexSource('abc%')).toBe('^abc.*$');
    expect(likeToRegexSource('a_c')).toBe('^a.c$');
  });

  it('escapes regex metacharacters in the literal part', () => {
    expect(likeToRegexSource('a.b%')).toBe('^a\\.b.*$');
    expect(likeToRegexSource('(x)%')).toBe('^\\(x\\).*$');
  });
});

describe('filterToMongo', () => {
  it('maps comparison operators', () => {
    expect(filterToMongo(field('age', 'gt', 18))).toEqual({ 'data.age': { $gt: 18 } });
    expect(filterToMongo(field('age', 'lte', 65))).toEqual({ 'data.age': { $lte: 65 } });
    expect(filterToMongo(field('name', 'eq', 'x'))).toEqual({ 'data.name': { $eq: 'x' } });
    expect(filterToMongo(field('name', 'neq', 'x'))).toEqual({ 'data.name': { $ne: 'x' } });
  });

  it('maps in/nin with array coercion', () => {
    expect(filterToMongo(field('status', 'in', ['a', 'b']))).toEqual({
      'data.status': { $in: ['a', 'b'] },
    });
    expect(filterToMongo(field('status', 'nin', 'a'))).toEqual({
      'data.status': { $nin: ['a'] },
    });
  });

  it('maps contains / containsAny', () => {
    expect(filterToMongo(field('tags', 'contains', 'vip'))).toEqual({
      'data.tags': { $all: ['vip'] },
    });
    expect(filterToMongo(field('tags', 'containsAny', ['a', 'b']))).toEqual({
      'data.tags': { $in: ['a', 'b'] },
    });
  });

  it('maps exists / regex / iregex / like / ilike', () => {
    expect(filterToMongo(field('email', 'exists', true))).toEqual({
      'data.email': { $exists: true },
    });
    expect(filterToMongo(field('email', 'exists', false))).toEqual({
      'data.email': { $exists: false },
    });
    expect(filterToMongo(field('name', 'regex', '^Jo'))).toEqual({
      'data.name': { $regex: '^Jo' },
    });
    expect(filterToMongo(field('name', 'iregex', '^jo'))).toEqual({
      'data.name': { $regex: '^jo', $options: 'i' },
    });
    expect(filterToMongo(field('name', 'like', 'Jo%'))).toEqual({
      'data.name': { $regex: '^Jo.*$' },
    });
    expect(filterToMongo(field('name', 'ilike', 'jo%'))).toEqual({
      'data.name': { $regex: '^jo.*$', $options: 'i' },
    });
  });

  it('maps and/or/not combinators', () => {
    const f: Filter = {
      type: 'and',
      conditions: [
        field('a', 'eq', 1),
        {
          type: 'or',
          conditions: [field('b', 'gt', 2), { type: 'not', condition: field('c', 'eq', 3) }],
        },
      ],
    };
    expect(filterToMongo(f)).toEqual({
      $and: [
        { 'data.a': { $eq: 1 } },
        {
          $or: [
            { 'data.b': { $gt: 2 } },
            { $nor: [{ 'data.c': { $eq: 3 } }] },
          ],
        },
      ],
    });
  });

  it('round-trips a parsed JS query filter', () => {
    const parsed = parseJsQuery(
      "db.orders.find({ status: 'paid', total: { $gte: 100 } }).sort({ _createdAt: -1 }).limit(10)",
    );
    const mongo = filterToMongo(parsed.query.filter!);
    expect(mongo).toEqual({
      $and: [
        { 'data.status': { $eq: 'paid' } },
        { 'data.total': { $gte: 100 } },
      ],
    });
    expect(sortToMongo(parsed.query.sort!)).toEqual({ 'envelope.createdAt': -1 });
  });
});

describe('selectToMongo', () => {
  it('builds an inclusion projection keeping the envelope', () => {
    expect(
      selectToMongo([
        { path: 'name', isArrayPath: false },
        { path: 'customer.city', isArrayPath: false },
      ]),
    ).toEqual({ envelope: 1, 'data.name': 1, 'data.customer.city': 1 });
  });
});

describe('aggregationToMongoPipeline', () => {
  const scope = { projectId: 'p1', entity: 'orders' };
  const scopeMatch = {
    $match: {
      'envelope.projectId': 'p1',
      'envelope.entity': 'orders',
      'envelope.status': { $ne: 'deleted' },
    },
  };

  it('prepends the tenant scope $match', () => {
    const agg = validateAggregation('orders', [{ $limit: 5 }]);
    const { pipeline, reshaped } = aggregationToMongoPipeline(agg, scope);
    expect(pipeline[0]).toEqual(scopeMatch);
    expect(pipeline[1]).toEqual({ $limit: 5 });
    expect(reshaped).toBe(false);
  });

  it('translates $match filters through the validator output', () => {
    const agg = validateAggregation('orders', [
      { $match: { status: 'active', total: { $gt: 100 } } },
    ]);
    const { pipeline } = aggregationToMongoPipeline(agg, scope);
    expect(pipeline[1]).toEqual({
      $match: {
        $and: [
          { 'data.status': { $eq: 'active' } },
          { 'data.total': { $gt: 100 } },
        ],
      },
    });
  });

  it('translates $group with accumulators and flips reshape', () => {
    const agg = validateAggregation('orders', [
      {
        $group: {
          _id: 'customer.city',
          orders: { $count: null },
          revenue: { $sum: 'total' },
        },
      },
      { $sort: { revenue: 'desc' } },
      { $limit: 3 },
    ]);
    const { pipeline, reshaped } = aggregationToMongoPipeline(agg, scope);
    expect(reshaped).toBe(true);
    expect(pipeline[1]).toEqual({
      $group: {
        _id: '$data.customer.city',
        orders: { $sum: 1 },
        revenue: { $sum: '$data.total' },
      },
    });
    // Post-group sort addresses the grouped key directly (no data. prefix).
    expect(pipeline[2]).toEqual({ $sort: { revenue: -1 } });
    expect(pipeline[3]).toEqual({ $limit: 3 });
  });

  it('translates composite group keys', () => {
    const agg = validateAggregation('orders', [
      {
        $group: {
          _id: ['customer.city', 'status'],
          n: { $count: null },
        },
      },
    ]);
    const { pipeline } = aggregationToMongoPipeline(agg, scope);
    expect(pipeline[1]).toEqual({
      $group: {
        _id: { city: '$data.customer.city', status: '$data.status' },
        n: { $sum: 1 },
      },
    });
  });

  it('translates $project inclusion and aliases, flipping reshape', () => {
    const agg = validateAggregation('orders', [
      { $project: { name: 1, city: 'customer.city', flag: { $literal: 7 } } },
      { $sort: { city: 'asc' } },
    ]);
    const { pipeline, reshaped } = aggregationToMongoPipeline(agg, scope);
    expect(reshaped).toBe(true);
    expect(pipeline[1]).toEqual({
      $project: {
        name: '$data.name',
        city: '$data.customer.city',
        flag: { $literal: 7 },
      },
    });
    expect(pipeline[2]).toEqual({ $sort: { city: 1 } });
  });

  it('translates $unwind with array path markers stripped', () => {
    const agg = validateAggregation('orders', [
      { $unwind: { path: 'items[]', preserveNullAndEmpty: true } },
    ]);
    const { pipeline } = aggregationToMongoPipeline(agg, scope);
    expect(pipeline[1]).toEqual({
      $unwind: { path: '$data.items', preserveNullAndEmptyArrays: true },
    });
  });
});
