/**
 * Name sanitization and mapping for the Data Engine tenancy layer.
 *
 * Logical names (user-facing) are mapped to physical names (store-safe).
 * The mapping is stored in PostgreSQL so renames never touch physical storage.
 */

/** Max physical name length (conservative; most stores allow 251+). */
const MAX_PHYSICAL_NAME_LENGTH = 128;

/** Characters allowed in physical names. */
const SAFE_CHARS_RE = /[^a-z0-9_]/g;

/**
 * Sanitize a user-facing entity name into a safe physical name.
 *
 * "Patient Records" → "patient_records"
 * "Line Items (2024)" → "line_items_2024"
 * "café-orders" → "caf_orders"
 */
export function sanitizeEntityName(logicalName: string): string {
  let name = logicalName
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '_')
    .replace(/-+/g, '_')
    .replace(SAFE_CHARS_RE, '')
    .replace(/_+/g, '_')
    .replace(/^_|_$/g, '');

  if (!name || /^\d/.test(name)) {
    name = `e_${name}`;
  }

  if (name.length > MAX_PHYSICAL_NAME_LENGTH) {
    name = name.slice(0, MAX_PHYSICAL_NAME_LENGTH);
  }

  return name;
}

/**
 * Generate the physical namespace name for a dedicated-scope tenant.
 * "prj_abc123" — deterministic from projectId.
 */
export function dedicatedScopeName(projectId: string): string {
  const safe = projectId.replace(SAFE_CHARS_RE, '').slice(0, 100);
  return `prj_${safe}`;
}

/**
 * The shared namespace name used by all shared-tier tenants.
 */
export const SHARED_NAMESPACE = 'projects';

/**
 * The shared collection name for the shared-records strategy.
 */
export const SHARED_RECORDS_COLLECTION = 'records';

/**
 * The default container (bucket) name.
 */
export const DEFAULT_CONTAINER = 'basefyio-apps';

/**
 * Validate that a logical entity name is acceptable.
 */
export function validateEntityName(name: string): { valid: boolean; error?: string } {
  if (!name || typeof name !== 'string') {
    return { valid: false, error: 'Entity name is required' };
  }
  if (name.length > 255) {
    return { valid: false, error: 'Entity name must be 255 characters or fewer' };
  }
  if (/^\s|\s$/.test(name)) {
    return { valid: false, error: 'Entity name must not start or end with whitespace' };
  }
  return { valid: true };
}
