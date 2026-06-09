/**
 * Name Sanitization Unit Tests
 */

import {
  sanitizeEntityName,
  dedicatedScopeName,
  validateEntityName,
  SHARED_NAMESPACE,
  SHARED_RECORDS_COLLECTION,
  DEFAULT_CONTAINER,
} from '../tenancy/names';

describe('sanitizeEntityName', () => {
  it('should lowercase and replace spaces', () => {
    expect(sanitizeEntityName('Patient Records')).toBe('patient_records');
  });

  it('should replace hyphens with underscores', () => {
    expect(sanitizeEntityName('line-items')).toBe('line_items');
  });

  it('should remove special characters', () => {
    expect(sanitizeEntityName('Line Items (2024)')).toBe('line_items_2024');
  });

  it('should handle accented characters by removing them', () => {
    expect(sanitizeEntityName('cafe-orders')).toBe('cafe_orders');
  });

  it('should prefix names starting with numbers', () => {
    expect(sanitizeEntityName('123records')).toBe('e_123records');
  });

  it('should truncate long names', () => {
    const longName = 'a'.repeat(200);
    expect(sanitizeEntityName(longName).length).toBeLessThanOrEqual(128);
  });

  it('should handle empty/whitespace input', () => {
    const result = sanitizeEntityName('   ');
    expect(result.length).toBeGreaterThan(0);
  });

  it('should collapse multiple underscores', () => {
    expect(sanitizeEntityName('foo___bar')).toBe('foo_bar');
  });
});

describe('dedicatedScopeName', () => {
  it('should prefix with prj_', () => {
    expect(dedicatedScopeName('abc123')).toBe('prj_abc123');
  });

  it('should sanitize project IDs', () => {
    expect(dedicatedScopeName('project-with-dashes!')).toBe('prj_projectwithdashes');
  });
});

describe('validateEntityName', () => {
  it('should accept valid names', () => {
    expect(validateEntityName('patients')).toEqual({ valid: true });
    expect(validateEntityName('Line Items 2024')).toEqual({ valid: true });
  });

  it('should reject empty names', () => {
    expect(validateEntityName('')).toEqual({ valid: false, error: expect.any(String) });
  });

  it('should reject very long names', () => {
    expect(validateEntityName('a'.repeat(300))).toEqual({ valid: false, error: expect.any(String) });
  });
});

describe('constants', () => {
  it('should have correct defaults', () => {
    expect(SHARED_NAMESPACE).toBe('projects');
    expect(SHARED_RECORDS_COLLECTION).toBe('records');
    expect(DEFAULT_CONTAINER).toBe('basefyio-apps');
  });
});
