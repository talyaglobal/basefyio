import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import { RagSearchQuery } from './rag-search.query';

function errorsFor(input: Record<string, unknown>) {
  const dto = plainToInstance(RagSearchQuery, input);
  return validateSync(dto as object).flatMap((e) => Object.keys(e.constraints ?? {}));
}

describe('RagSearchQuery validation', () => {
  it('requires a non-empty q', () => {
    expect(errorsFor({}).length).toBeGreaterThan(0);
    expect(errorsFor({ q: '' }).length).toBeGreaterThan(0);
    expect(errorsFor({ q: 'hello' })).toHaveLength(0);
  });

  it('accepts limit within 1–25 and rejects outside', () => {
    expect(errorsFor({ q: 'x', limit: 1 })).toHaveLength(0);
    expect(errorsFor({ q: 'x', limit: 25 })).toHaveLength(0);
    expect(errorsFor({ q: 'x', limit: 0 }).length).toBeGreaterThan(0);
    expect(errorsFor({ q: 'x', limit: 26 }).length).toBeGreaterThan(0);
  });

  it('accepts threshold within 0–1 and rejects outside', () => {
    expect(errorsFor({ q: 'x', threshold: 0 })).toHaveLength(0);
    expect(errorsFor({ q: 'x', threshold: 1 })).toHaveLength(0);
    expect(errorsFor({ q: 'x', threshold: -0.1 }).length).toBeGreaterThan(0);
    expect(errorsFor({ q: 'x', threshold: 1.1 }).length).toBeGreaterThan(0);
  });

  it('applies defaults when omitted', () => {
    const dto = plainToInstance(RagSearchQuery, { q: 'x' });
    expect(dto.limit).toBe(8);
    expect(dto.threshold).toBe(0.45);
  });
});
