import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PROFILES } from '@mediacompressor/compression/types';

/**
 * Plan 8e Task 5 (review concern #2, Minor): enum-cross-link guard.
 *
 * `upload-wizard-page.ts` and the new `tProfile` Handlebars helper both
 * compute the i18next lookup key dynamically as
 * `profile_${profile.replaceAll('-', '_')}` from `PROFILES` (the
 * compression-package canonical const-array). If a future refactor adds a
 * new profile to `PROFILES` without also adding the corresponding
 * `profile_<canonical>` translation in BOTH `apps/api/locales/en/jobs.json`
 * AND `apps/api/locales/de/jobs.json`, i18next's missing-key handler would
 * silently render the bare key (e.g. `profile_4k_archive`) — visible to
 * QA, but no test would catch it before merge.
 *
 * This test pins the cross-link: PROFILES <-> jobs.json's `profile_*` keys.
 * Same guard for the implicit kind-enum (`['image', 'video']`, see
 * `apps/api/src/jobs/jobs-routes.ts:21,32` and
 * `apps/api/src/uploads/pre-create-hook.ts:100`) — if a kind is added to
 * the enum without a `kind_<canonical>` translation, the dashboard / list /
 * detail pages would render the bare key.
 *
 * The kind-enum is intentionally inlined here (no exported `KINDS` const
 * exists today; the canonical source is the duplicated z.enum() literal in
 * jobs-routes + the literal-comparison in pre-create-hook). If a `KINDS`
 * const is later introduced in `packages/compression/src/types.ts`, swap
 * the import — the assertion below stays the same.
 */
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LOCALES_DIR = path.join(__dirname, '..', '..', 'locales');

// Canonical kind-enum strings. Source of truth = `JobKind` enum in
// `packages/db/prisma/schema.prisma` (image | video). Kept in sync with
// `apps/api/src/jobs/jobs-routes.ts:21` and
// `apps/api/src/uploads/pre-create-hook.ts:100`.
const KINDS = ['image', 'video'] as const;

/**
 * Load a locale JSON file and return its top-level entries as a Map. Using a
 * Map (rather than direct `obj[key]` bracket-access on the parsed object)
 * sidesteps the `security/detect-object-injection` ESLint rule for
 * computed-string property reads — the rule is conservative against
 * prototype-pollution / property-injection vectors that don't apply here
 * (the keys originate from a hardcoded const-array, not user input), but
 * the Map-based shape both passes lint cleanly AND matches how i18next
 * itself stores resource bundles internally.
 */
function loadJobsJson(locale: 'en' | 'de'): Map<string, unknown> {
  const raw = readFileSync(path.join(LOCALES_DIR, locale, 'jobs.json'), 'utf-8');
  const parsed = JSON.parse(raw) as Record<string, unknown>;
  return new Map(Object.entries(parsed));
}

function assertNonEmptyString(
  value: unknown,
  ctx: string,
): asserts value is string {
  expect(typeof value, `${ctx}: expected string`).toBe('string');
  expect((value as string).length, `${ctx}: expected non-empty`).toBeGreaterThan(0);
}

describe('jobs.json <-> PROFILES/KINDS enum-cross-link (review concern #2)', () => {
  it('every PROFILES entry has profile_<canonical> in en/jobs.json AND de/jobs.json', () => {
    const enJobs = loadJobsJson('en');
    const deJobs = loadJobsJson('de');
    for (const profile of PROFILES) {
      const key = `profile_${profile.replaceAll('-', '_')}`;
      const enValue = enJobs.get(key);
      const deValue = deJobs.get(key);
      expect(enValue, `en/jobs.json missing ${key}`).toBeTruthy();
      expect(deValue, `de/jobs.json missing ${key}`).toBeTruthy();
      // Both values MUST be non-empty strings — a deliberately-empty value
      // would silently render as nothing in the UI (no i18next missing-key
      // fallback because the key DOES exist), which is a worse failure mode
      // than a bare-key render.
      assertNonEmptyString(enValue, `en/jobs.json[${key}]`);
      assertNonEmptyString(deValue, `de/jobs.json[${key}]`);
    }
  });

  it('every KIND entry has kind_<canonical> in en/jobs.json AND de/jobs.json', () => {
    const enJobs = loadJobsJson('en');
    const deJobs = loadJobsJson('de');
    for (const kind of KINDS) {
      const key = `kind_${kind}`;
      const enValue = enJobs.get(key);
      const deValue = deJobs.get(key);
      expect(enValue, `en/jobs.json missing ${key}`).toBeTruthy();
      expect(deValue, `de/jobs.json missing ${key}`).toBeTruthy();
      assertNonEmptyString(enValue, `en/jobs.json[${key}]`);
      assertNonEmptyString(deValue, `de/jobs.json[${key}]`);
    }
  });
});
