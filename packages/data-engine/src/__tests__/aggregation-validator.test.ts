/**
 * Tests for the aggregation pipeline validator.
 *
 * Covers: a valid pipeline mirroring the TikTok fixture's
 * topCreatorsAggregation, every stage's happy path, and every validation
 * rule violation (blocked stages, smuggled $where, injection-shaped paths,
 * size caps, prototype-pollution keys, ...).
 */

import { validateAggregation } from '../query/aggregation-validator';
import { QueryValidationError } from '../interfaces/data-engine';
import { TIKTOK_FIXTURE } from '../__fixtures__/tiktok-model';

/** Assert fn throws QueryValidationError whose message matches `re`. */
function expectValidationError(fn: () => unknown, re: RegExp): void {
  let thrown: unknown;
  try {
    fn();
  } catch (e) {
    thrown = e;
  }
  expect(thrown).toBeInstanceOf(QueryValidationError);
  expect((thrown as QueryValidationError).message).toMatch(re);
}

describe('validateAggregation', () => {
  // ── Fixture mirror ─────────────────────────────────────

  it('compiles the topCreators DSL pipeline to the exact fixture AST', () => {
    const result = validateAggregation('videos', [
      { $match: { 'moderation.status': 'approved' } },
      {
        $group: {
          _id: 'authorSnapshot.userId',
          totalViews: { $sum: 'stats.views' },
          videoCount: { $count: null },
        },
      },
      { $sort: { totalViews: -1 } },
      { $limit: 10 },
    ]);
    expect(result).toEqual(TIKTOK_FIXTURE.aggregations.topCreators);
  });

  // ── Stage happy paths ──────────────────────────────────

  it('compiles $match with operator objects', () => {
    const result = validateAggregation('videos', [
      { $match: { 'stats.views': { $gte: 1000 } } },
    ]);
    expect(result.pipeline[0]).toEqual({
      $match: {
        type: 'field',
        path: { path: 'stats.views', isArrayPath: false },
        operator: 'gte',
        value: 1000,
      },
    });
  });

  it('compiles $project with 0/1, path-reference strings, and $literal', () => {
    const result = validateAggregation('videos', [
      {
        $project: {
          title: 1,
          description: 0,
          author: 'authorSnapshot.username',
          source: { $literal: { channel: 'feed', rank: 1 } },
        },
      },
    ]);
    expect(result.pipeline[0]).toEqual({
      $project: {
        title: 1,
        description: 0,
        author: 'authorSnapshot.username',
        source: { $literal: { channel: 'feed', rank: 1 } },
      },
    });
  });

  it('compiles $unwind from a string path and marks [] paths as array paths', () => {
    const result = validateAggregation('videos', [{ $unwind: 'hashtags[]' }]);
    expect(result.pipeline[0]).toEqual({
      $unwind: { path: { path: 'hashtags[]', isArrayPath: true } },
    });
  });

  it('compiles $unwind from object form with preserveNullAndEmpty', () => {
    const result = validateAggregation('videos', [
      { $unwind: { path: 'hashtags', preserveNullAndEmpty: true } },
    ]);
    expect(result.pipeline[0]).toEqual({
      $unwind: {
        path: { path: 'hashtags', isArrayPath: false },
        preserveNullAndEmpty: true,
      },
    });
  });

  it('compiles $group with _id: null', () => {
    const result = validateAggregation('videos', [
      { $group: { _id: null, total: { $count: null } } },
    ]);
    expect(result.pipeline[0]).toEqual({
      $group: { _id: null, accumulators: { total: { op: '$count' } } },
    });
  });

  it('compiles $group with an array _id (composite key)', () => {
    const result = validateAggregation('videos', [
      {
        $group: {
          _id: ['authorSnapshot.userId', 'moderation.status'],
          avgViews: { $avg: 'stats.views' },
          maxLikes: { $max: 'stats.likes' },
          minLikes: { $min: 'stats.likes' },
        },
      },
    ]);
    expect(result.pipeline[0]).toEqual({
      $group: {
        _id: [
          { path: 'authorSnapshot.userId', isArrayPath: false },
          { path: 'moderation.status', isArrayPath: false },
        ],
        accumulators: {
          avgViews: { op: '$avg', path: { path: 'stats.views', isArrayPath: false } },
          maxLikes: { op: '$max', path: { path: 'stats.likes', isArrayPath: false } },
          minLikes: { op: '$min', path: { path: 'stats.likes', isArrayPath: false } },
        },
      },
    });
  });

  it('compiles $sort with 1/-1 and "asc"/"desc" directions', () => {
    const result = validateAggregation('videos', [
      { $sort: { 'stats.views': -1, title: 'asc' } },
    ]);
    expect(result.pipeline[0]).toEqual({
      $sort: [
        { path: { path: 'stats.views', isArrayPath: false }, direction: 'desc' },
        { path: { path: 'title', isArrayPath: false }, direction: 'asc' },
      ],
    });
  });

  it('accepts $limit and $skip at their boundaries', () => {
    const result = validateAggregation('videos', [
      { $limit: 1 },
      { $limit: 1000 },
      { $skip: 0 },
      { $skip: 100000 },
    ]);
    expect(result.pipeline).toEqual([
      { $limit: 1 },
      { $limit: 1000 },
      { $skip: 0 },
      { $skip: 100000 },
    ]);
  });

  // ── Entity name ────────────────────────────────────────

  it('rejects invalid entity names', () => {
    expectValidationError(() => validateAggregation('123videos', [{ $limit: 1 }]), /invalid entity name/);
    expectValidationError(() => validateAggregation('videos; DROP TABLE', [{ $limit: 1 }]), /invalid entity name/);
    expectValidationError(() => validateAggregation('', [{ $limit: 1 }]), /invalid entity name/);
    expectValidationError(() => validateAggregation('__proto__', [{ $limit: 1 }]), /invalid entity name/);
  });

  // ── Pipeline shape ─────────────────────────────────────

  it('rejects a non-array pipeline', () => {
    expectValidationError(
      () => validateAggregation('videos', { $match: { a: 1 } }),
      /pipeline must be an array/,
    );
  });

  it('rejects an empty pipeline', () => {
    expectValidationError(() => validateAggregation('videos', []), /at least one stage/);
  });

  it('rejects pipelines with more than 20 stages', () => {
    const stages = Array.from({ length: 21 }, () => ({ $limit: 10 }));
    expectValidationError(
      () => validateAggregation('videos', stages),
      /21 stages — maximum is 20/,
    );
  });

  it('rejects stages that are not plain objects', () => {
    expectValidationError(() => validateAggregation('videos', ['$match']), /plain object/);
    expectValidationError(() => validateAggregation('videos', [null]), /plain object/);
    expectValidationError(() => validateAggregation('videos', [[{ $limit: 1 }]]), /plain object/);
  });

  it('rejects stage objects with two or more keys, naming the keys', () => {
    expectValidationError(
      () => validateAggregation('videos', [{ $match: { a: 1 }, $limit: 5 }]),
      /exactly one key, found 2 \(\$match, \$limit\)/,
    );
  });

  it('rejects empty stage objects', () => {
    expectValidationError(() => validateAggregation('videos', [{}]), /stage object is empty/);
  });

  // ── Blocked and unknown stages ─────────────────────────

  it('rejects blocked stages with a specific message', () => {
    expectValidationError(
      () => validateAggregation('videos', [{ $lookup: { from: 'users' } }]),
      /stage "\$lookup" is blocked/,
    );
    expectValidationError(
      () => validateAggregation('videos', [{ $out: 'evil' }]),
      /stage "\$out" is blocked/,
    );
    expectValidationError(
      () => validateAggregation('videos', [{ $where: 'this.x === 1' }]),
      /stage "\$where" is blocked/,
    );
    expectValidationError(
      () => validateAggregation('videos', [{ $function: { body: 'x => x' } }]),
      /stage "\$function" is blocked/,
    );
  });

  it('rejects unknown stages', () => {
    expectValidationError(
      () => validateAggregation('videos', [{ $facet: {} }]),
      /unknown stage "\$facet"/,
    );
  });

  // ── $match violations ──────────────────────────────────

  it('rejects an empty $match object', () => {
    expectValidationError(
      () => validateAggregation('videos', [{ $match: {} }]),
      /empty \$match — remove the stage/,
    );
  });

  it('rejects $where smuggled inside a $match value', () => {
    expectValidationError(
      () => validateAggregation('videos', [{ $match: { $where: 'this.a == 1' } }]),
      /unknown top-level operator "\$where"/,
    );
    expectValidationError(
      () => validateAggregation('videos', [{ $match: { title: { $where: '1' } } }]),
      /unknown operator "\$where"/,
    );
  });

  it('rejects injection-shaped paths inside $match', () => {
    expectValidationError(
      () => validateAggregation('videos', [{ $match: { "title' OR 1=1 --": 'x' } }]),
      /invalid field path/,
    );
  });

  // ── $sort violations ───────────────────────────────────

  it('rejects invalid sort directions and unsafe sort paths', () => {
    expectValidationError(
      () => validateAggregation('videos', [{ $sort: { title: 2 } }]),
      /invalid sort direction/,
    );
    expectValidationError(
      () => validateAggregation('videos', [{ $sort: { 'a;b': 1 } }]),
      /invalid field path/,
    );
  });

  // ── $limit / $skip violations ──────────────────────────

  it('rejects out-of-range or non-integer $limit', () => {
    expectValidationError(() => validateAggregation('videos', [{ $limit: 0 }]), /\$limit must be an integer between 1 and 1000/);
    expectValidationError(() => validateAggregation('videos', [{ $limit: 1001 }]), /\$limit must be an integer between 1 and 1000/);
    expectValidationError(() => validateAggregation('videos', [{ $limit: 2.5 }]), /\$limit must be an integer/);
    expectValidationError(() => validateAggregation('videos', [{ $limit: '10' }]), /\$limit must be an integer/);
  });

  it('rejects out-of-range $skip', () => {
    expectValidationError(() => validateAggregation('videos', [{ $skip: -1 }]), /\$skip must be an integer between 0 and 100000/);
    expectValidationError(() => validateAggregation('videos', [{ $skip: 100001 }]), /\$skip must be an integer between 0 and 100000/);
  });

  // ── $project violations ────────────────────────────────

  it('rejects non-object, empty, and oversized $project values', () => {
    expectValidationError(() => validateAggregation('videos', [{ $project: 'title' }]), /\$project must be a plain object/);
    expectValidationError(() => validateAggregation('videos', [{ $project: {} }]), /at least one field/);

    const tooMany: Record<string, 1> = {};
    for (let i = 0; i < 51; i++) tooMany[`field_${i}`] = 1;
    expectValidationError(
      () => validateAggregation('videos', [{ $project: tooMany }]),
      /51 fields — maximum is 50/,
    );
  });

  it('rejects $project values that are not 0, 1, path string, or $literal', () => {
    expectValidationError(() => validateAggregation('videos', [{ $project: { title: true } }]), /invalid value for \$project field "title"/);
    expectValidationError(() => validateAggregation('videos', [{ $project: { title: 2 } }]), /invalid value for \$project field "title"/);
    expectValidationError(
      () => validateAggregation('videos', [{ $project: { title: { $concat: ['a', 'b'] } } }]),
      /only \{ "\$literal": <value> \} is supported/,
    );
    expectValidationError(
      () => validateAggregation('videos', [{ $project: { title: { $literal: 1, extra: 2 } } }]),
      /only \{ "\$literal": <value> \} is supported/,
    );
  });

  it('passes $literal values through but rejects forbidden keys inside them', () => {
    const ok = validateAggregation('videos', [
      { $project: { flag: { $literal: [1, 'two', { three: null }] } } },
    ]);
    expect(ok.pipeline[0]).toEqual({
      $project: { flag: { $literal: [1, 'two', { three: null }] } },
    });

    const poisoned = JSON.parse('{ "$project": { "flag": { "$literal": { "__proto__": { "x": 1 } } } } }');
    expectValidationError(
      () => validateAggregation('videos', [poisoned]),
      /key "__proto__" is not allowed/,
    );
  });

  it('rejects injection-shaped and forbidden $project keys and path values', () => {
    expectValidationError(
      () => validateAggregation('videos', [{ $project: { 'a"; DROP TABLE x; --': 1 } }]),
      /invalid field path/,
    );
    expectValidationError(
      () => validateAggregation('videos', [{ $project: { alias: '../etc/passwd' } }]),
      /invalid field path/,
    );
    const protoKey = JSON.parse('{ "$project": { "__proto__": 1 } }');
    expectValidationError(
      () => validateAggregation('videos', [protoKey]),
      /not allowed/,
    );
  });

  // ── $unwind violations ─────────────────────────────────

  it('rejects malformed $unwind values', () => {
    expectValidationError(() => validateAggregation('videos', [{ $unwind: 42 }]), /\$unwind must be a path string/);
    expectValidationError(() => validateAggregation('videos', [{ $unwind: {} }]), /\$unwind requires a "path" string/);
    expectValidationError(
      () => validateAggregation('videos', [{ $unwind: { path: 'tags', includeArrayIndex: 'i' } }]),
      /unknown \$unwind option "includeArrayIndex"/,
    );
    expectValidationError(
      () => validateAggregation('videos', [{ $unwind: { path: 'tags', preserveNullAndEmpty: 'yes' } }]),
      /"preserveNullAndEmpty" must be a boolean/,
    );
    expectValidationError(
      () => validateAggregation('videos', [{ $unwind: 'tags[0]' }]),
      /invalid field path/,
    );
  });

  // ── $group violations ──────────────────────────────────

  it('rejects $group without _id or with an invalid _id', () => {
    expectValidationError(
      () => validateAggregation('videos', [{ $group: { total: { $count: null } } }]),
      /\$group requires an "_id" key/,
    );
    expectValidationError(
      () => validateAggregation('videos', [{ $group: { _id: 42, total: { $count: null } } }]),
      /"_id" must be null, a field path string, or an array/,
    );
    expectValidationError(
      () => validateAggregation('videos', [{ $group: { _id: [], total: { $count: null } } }]),
      /at least one path string/,
    );
    expectValidationError(
      () => validateAggregation('videos', [{ $group: { _id: ['a', 7], total: { $count: null } } }]),
      /array items must be field path strings/,
    );
  });

  it('rejects $group _id arrays with more than 5 paths', () => {
    expectValidationError(
      () =>
        validateAggregation('videos', [
          { $group: { _id: ['a', 'b', 'c', 'd', 'e', 'f'], total: { $count: null } } },
        ]),
      /6 paths — maximum is 5/,
    );
  });

  it('rejects $group without accumulators or with too many', () => {
    expectValidationError(
      () => validateAggregation('videos', [{ $group: { _id: null } }]),
      /at least one accumulator field/,
    );

    const group: Record<string, unknown> = { _id: null };
    for (let i = 0; i < 21; i++) group[`acc_${i}`] = { $count: null };
    expectValidationError(
      () => validateAggregation('videos', [{ $group: group }]),
      /21 accumulator fields — maximum is 20/,
    );
  });

  it('rejects malformed accumulators', () => {
    expectValidationError(
      () => validateAggregation('videos', [{ $group: { _id: null, total: 'stats.views' } }]),
      /accumulator "total" must be an object/,
    );
    expectValidationError(
      () => validateAggregation('videos', [{ $group: { _id: null, total: { $sum: 'a', $avg: 'b' } } }]),
      /exactly one operator key, found 2/,
    );
    expectValidationError(
      () => validateAggregation('videos', [{ $group: { _id: null, total: { $first: 'a' } } }]),
      /unknown accumulator "\$first"/,
    );
    expectValidationError(
      () => validateAggregation('videos', [{ $group: { _id: null, total: { $count: 1 } } }]),
      /"\$count" on "total" takes null/,
    );
    expectValidationError(
      () => validateAggregation('videos', [{ $group: { _id: null, total: { $sum: null } } }]),
      /requires a field path string/,
    );
    expectValidationError(
      () => validateAggregation('videos', [{ $group: { _id: null, total: { $sum: 'a;b' } } }]),
      /invalid field path/,
    );
  });

  it('rejects invalid and forbidden $group output field names', () => {
    expectValidationError(
      () => validateAggregation('videos', [{ $group: { _id: null, 'bad-name': { $count: null } } }]),
      /invalid \$group output field name "bad-name"/,
    );
    expectValidationError(
      () => validateAggregation('videos', [{ $group: { _id: null, '1abc': { $count: null } } }]),
      /invalid \$group output field name "1abc"/,
    );
    const poisoned = JSON.parse('{ "_id": null, "__proto__": { "$count": null } }');
    expectValidationError(
      () => validateAggregation('videos', [{ $group: poisoned }]),
      /\$group output field "__proto__" is not allowed/,
    );
  });

  // ── Error class contract ───────────────────────────────

  it('throws QueryValidationError with code QUERY_VALIDATION_FAILED and HTTP 400', () => {
    try {
      validateAggregation('videos', [{ $lookup: {} }]);
      throw new Error('expected validateAggregation to throw');
    } catch (e) {
      expect(e).toBeInstanceOf(QueryValidationError);
      expect((e as QueryValidationError).code).toBe('QUERY_VALIDATION_FAILED');
      expect((e as QueryValidationError).statusCode).toBe(400);
    }
  });
});
