import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Plan 8e Task 1 PFLICHT (WC-i18n-9, Rev. 2): untranslated-drift detection.
 *
 * The key-parity test (i18n-key-parity.test.ts) catches *missing* keys but
 * NOT untranslated-drift — a translator can paste the EN value into de/<ns>.json
 * verbatim ("Sign in" -> "Sign in" instead of "Anmelden") and parity stays
 * green while DE users see English. This test asserts every DE-value differs
 * from the corresponding EN-value, except for an explicit IDENTICAL_BY_DESIGN
 * allowlist of proper nouns / single-letter labels / standard technical terms.
 *
 * **IDENTICAL_BY_DESIGN policy (Rev. 2.1, WC-i18n-18):** add an entry ONLY if
 * the value genuinely has no DE equivalent (brand names, single-char labels,
 * established Anglicisms). NEVER use it to silence "translation not done yet"
 * — that defeats the guard's purpose. If a DE translation isn't ready, the
 * task isn't done; ship the DE first.
 */
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LOCALES_DIR = path.join(__dirname, '..', '..', 'locales');

/**
 * Keys whose DE-value is intentionally identical to EN. Each entry must be
 * justified — see the policy comment above.
 */
const IDENTICAL_BY_DESIGN = new Set<string>([
  // Sentinel keys (Plan 8e Task 1 Step 4-5) — `_namespace` is a self-identifier
  // that is the same string in every language by definition.
  'common._namespace',
  'auth._namespace',
  'dashboard._namespace',
  'jobs._namespace',
  'profile._namespace',
  'admin._namespace',

  // -- Plan 8d admin namespace (pre-existing, ratified in code-review) --
  // "Admin" — same word in DE; German uses it as the standard term for the role.
  'admin.page_title_dashboard',
  // "Dashboard" — established Anglicism in DE technical UI vocabulary.
  'admin.nav_dashboard',
  // "Status" — identical noun and meaning in DE; preferred over "Zustand".
  'admin.users_table_status',
  'admin.edit_user_label_status',
  'admin.invites_table_consumed',
  'admin.stats_jobs_table_status',
  // "Token" — established technical Anglicism in DE; "Marke" would be ambiguous.
  'admin.invite_created_label_token',
  // Locale-switcher labels: each language is rendered in its OWN name in BOTH
  // locale files (so a DE user sees "English" for the EN button, an EN user
  // also sees "English"). This is intentional UX — autonyms — and means the
  // EN-side string equals the DE-side string by design.
  'admin.locale_de', // "Deutsch" in both locales
  'admin.locale_en', // "English" in both locales

  // Add new entries here as deliberate exceptions, with a justifying comment.
]);

/**
 * Recursively flatten into [dotted-path, value] entries. Only string values
 * are emitted — non-string primitives are translation-file errors handled
 * elsewhere.
 */
function flatEntries(obj: unknown, prefix = ''): Array<[string, string]> {
  if (obj === null || typeof obj !== 'object') return [];
  return Object.entries(obj as Record<string, unknown>).flatMap(([k, v]) => {
    const full = prefix ? `${prefix}.${k}` : k;
    if (typeof v === 'string') return [[full, v] as [string, string]];
    if (typeof v === 'object' && v !== null) return flatEntries(v, full);
    return [];
  });
}

describe('locale untranslated-drift detection (DE !== EN)', () => {
  const namespaces = readdirSync(path.join(LOCALES_DIR, 'en'))
    .filter((f) => f.endsWith('.json'))
    .map((f) => f.replace(/\.json$/, ''));

  for (const ns of namespaces) {
    it(`${ns}: every DE-value differs from EN-value (unless allowlisted)`, () => {
      const enJson = JSON.parse(
        readFileSync(path.join(LOCALES_DIR, 'en', `${ns}.json`), 'utf-8'),
      );
      const deJson = JSON.parse(
        readFileSync(path.join(LOCALES_DIR, 'de', `${ns}.json`), 'utf-8'),
      );
      const enMap = new Map(flatEntries(enJson));
      const deMap = new Map(flatEntries(deJson));

      const violations: string[] = [];
      for (const [key, enValue] of enMap) {
        const deValue = deMap.get(key);
        if (deValue === undefined) continue; // covered by parity-test
        const fqKey = `${ns}.${key}`;
        if (deValue === enValue && !IDENTICAL_BY_DESIGN.has(fqKey)) {
          violations.push(
            `${fqKey}: "${enValue}" — add to IDENTICAL_BY_DESIGN if intentional, otherwise translate`,
          );
        }
      }
      expect(violations, violations.join('\n')).toEqual([]);
    });
  }
});
