import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Plan 8e Task 1 PFLICHT (WC-i18n-1): key-parity guard.
 *
 * For every namespace JSON in `apps/api/locales/en/`, asserts that the
 * corresponding `apps/api/locales/de/<ns>.json` has the EXACT same flattened
 * key-set. If a translator forgets a key (or adds an EN-only key during a
 * migration PR), this test fails fast with a clear diff — far better than
 * shipping silent fallback-to-EN renders to DE users.
 *
 * Resolved relative to this test file (NOT process.cwd()) so vitest works
 * regardless of which directory the runner is invoked from.
 */
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LOCALES_DIR = path.join(__dirname, '..', '..', 'locales');

/**
 * Recursively flattens an object into dotted-path keys. Values that are
 * non-string non-object (numbers, bools) are skipped — translation files
 * should only contain strings. Arrays are deliberately not recursed (i18next
 * does not use array-indexed keys in our setup).
 */
function flatKeys(obj: unknown, prefix = ''): string[] {
  if (obj === null || typeof obj !== 'object') return [];
  return Object.entries(obj as Record<string, unknown>).flatMap(([k, v]) => {
    const full = prefix ? `${prefix}.${k}` : k;
    return typeof v === 'object' && v !== null ? flatKeys(v, full) : [full];
  });
}

describe('locale key parity (en <-> de)', () => {
  // Discover namespaces from the en/ directory; de/ MUST mirror it (parity is
  // exactly what we're asserting). Filtering to .json so a stray .DS_Store or
  // editor-temp file doesn't crash the suite.
  const namespaces = readdirSync(path.join(LOCALES_DIR, 'en'))
    .filter((f) => f.endsWith('.json'))
    .map((f) => f.replace(/\.json$/, ''));

  for (const ns of namespaces) {
    it(`${ns}: en and de must have identical key sets`, () => {
      const enPath = path.join(LOCALES_DIR, 'en', `${ns}.json`);
      const dePath = path.join(LOCALES_DIR, 'de', `${ns}.json`);
      const enKeys = flatKeys(JSON.parse(readFileSync(enPath, 'utf-8'))).sort();
      const deKeys = flatKeys(JSON.parse(readFileSync(dePath, 'utf-8'))).sort();
      expect(deKeys, `de/${ns}.json keys differ from en/${ns}.json`).toEqual(enKeys);
    });
  }
});
