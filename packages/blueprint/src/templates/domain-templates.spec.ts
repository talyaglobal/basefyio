import { describe, it, expect } from 'vitest';
import { detectDomainFromTables, P0_TEMPLATES } from './domain-templates.js';

describe('detectDomainFromTables', () => {
  it('detects crm from customers table', () => {
    expect(detectDomainFromTables(['customers', 'activities'])).toBe('crm');
  });
  it('detects inventory from products table', () => {
    expect(detectDomainFromTables(['products', 'stock'])).toBe('inventory');
  });
  it('detects orders from orders table', () => {
    expect(detectDomainFromTables(['orders', 'shipments'])).toBe('orders');
  });
  it('falls back to generic when no match', () => {
    expect(detectDomainFromTables(['foo', 'bar'])).toBe('generic');
  });
  it('is case-insensitive', () => {
    expect(detectDomainFromTables(['CUSTOMERS'])).toBe('crm');
  });
  it('P0_TEMPLATES has 4 entries', () => {
    expect(Object.keys(P0_TEMPLATES)).toHaveLength(4);
  });
});
