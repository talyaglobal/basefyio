import { ForbiddenException, PayloadTooLargeException, RequestTimeoutException } from '@nestjs/common';
import { QueryGuard } from './query-guard';

const guard = new QueryGuard();

// ── assertQueryAllowed ────────────────────────────────────────────────────────

describe('QueryGuard.assertQueryAllowed', () => {
  it('READ cert + SELECT → allowed', () => {
    expect(() => guard.assertQueryAllowed('SELECT id FROM items', 'READ')).not.toThrow();
  });

  it('READ cert + SELECT with leading whitespace → allowed', () => {
    expect(() => guard.assertQueryAllowed('  SELECT * FROM users', 'READ')).not.toThrow();
  });

  it('READ cert + INSERT → ForbiddenException', () => {
    expect(() => guard.assertQueryAllowed("INSERT INTO items VALUES ('x')", 'READ')).toThrow(ForbiddenException);
  });

  it('READ cert + UPDATE → ForbiddenException', () => {
    expect(() => guard.assertQueryAllowed('UPDATE items SET name = ? WHERE id = ?', 'READ')).toThrow(ForbiddenException);
  });

  it('READ cert + DELETE → ForbiddenException', () => {
    expect(() => guard.assertQueryAllowed('DELETE FROM items WHERE id = 1', 'READ')).toThrow(ForbiddenException);
  });

  it('READ cert + DROP TABLE → ForbiddenException', () => {
    expect(() => guard.assertQueryAllowed('DROP TABLE items', 'READ')).toThrow(ForbiddenException);
  });

  it('READ cert + CREATE TABLE → ForbiddenException', () => {
    expect(() => guard.assertQueryAllowed('CREATE TABLE foo (id int)', 'READ')).toThrow(ForbiddenException);
  });

  it('READ cert + TRUNCATE → ForbiddenException', () => {
    expect(() => guard.assertQueryAllowed('TRUNCATE TABLE items', 'READ')).toThrow(ForbiddenException);
  });

  it('READ_WRITE cert + INSERT → allowed', () => {
    expect(() => guard.assertQueryAllowed("INSERT INTO items VALUES ('x')", 'READ_WRITE')).not.toThrow();
  });

  it('READ_WRITE cert + DELETE → allowed', () => {
    expect(() => guard.assertQueryAllowed('DELETE FROM items WHERE id = 1', 'READ_WRITE')).not.toThrow();
  });
});

// ── applyRowLimit ─────────────────────────────────────────────────────────────

describe('QueryGuard.applyRowLimit', () => {
  it('rows under limit → returned unchanged, truncated undefined', () => {
    const result = guard.applyRowLimit({ rows: [{ id: 1 }], rowCount: 1 }, 1000);
    expect(result.rows).toHaveLength(1);
    expect(result.truncated).toBeUndefined();
  });

  it('rows at limit → not truncated', () => {
    const rows = Array.from({ length: 1000 }, (_, i) => ({ id: i }));
    const result = guard.applyRowLimit({ rows, rowCount: 1000 }, 1000);
    expect(result.rows).toHaveLength(1000);
    expect(result.truncated).toBeUndefined();
  });

  it('rows over limit → sliced to maxRows, truncated=true', () => {
    const rows = Array.from({ length: 1500 }, (_, i) => ({ id: i }));
    const result = guard.applyRowLimit({ rows, rowCount: 1500 }, 1000);
    expect(result.rows).toHaveLength(1000);
    expect(result.truncated).toBe(true);
    expect(result.rowCount).toBe(1500);
  });
});

// ── assertPayloadSize ─────────────────────────────────────────────────────────

describe('QueryGuard.assertPayloadSize', () => {
  it('small payload → no throw', () => {
    const result = { rows: [{ id: 1, name: 'Alice' }], rowCount: 1 };
    expect(() => guard.assertPayloadSize(result, 5 * 1024 * 1024)).not.toThrow();
  });

  it('oversized payload → PayloadTooLargeException', () => {
    const bigValue = 'x'.repeat(200);
    const rows = Array.from({ length: 100 }, (_, i) => ({ id: i, data: bigValue }));
    expect(() => guard.assertPayloadSize({ rows, rowCount: 100 }, 100)).toThrow(PayloadTooLargeException);
  });
});

// ── withTimeout ───────────────────────────────────────────────────────────────

describe('QueryGuard.withTimeout', () => {
  it('fast promise resolves before timeout → returns value', async () => {
    const result = await guard.withTimeout(Promise.resolve(42), 1000);
    expect(result).toBe(42);
  });

  it('slow promise exceeds timeout → RequestTimeoutException', async () => {
    const never = new Promise<never>(() => {});
    await expect(guard.withTimeout(never, 10)).rejects.toBeInstanceOf(RequestTimeoutException);
  });

  it('rejected promise propagates original error (not timeout)', async () => {
    const boom = Promise.reject(new Error('db error'));
    await expect(guard.withTimeout(boom, 1000)).rejects.toThrow('db error');
  });
});
