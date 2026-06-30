import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Resolve the CLI version from its package.json.
 * `pkgDir` defaults to the package root relative to the compiled file.
 */
export function resolveVersion(pkgDir: string = join(__dirname, '..')): string {
  try {
    const raw = readFileSync(join(pkgDir, 'package.json'), 'utf8');
    const parsed = JSON.parse(raw) as { version?: string };
    return parsed.version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}
