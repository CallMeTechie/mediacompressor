import { describe, expect, it, beforeEach } from 'vitest';
import Handlebars from 'handlebars';
import {
  initI18n,
  resetI18n,
  registerFormatDateTimeHelper,
  registerFormatDateHelper,
  registerFormatBytesHelper,
} from './i18n.js';

describe('formatDateTime helper', () => {
  beforeEach(async () => {
    resetI18n();
    await initI18n();
    registerFormatDateTimeHelper();
  });

  it('formats ISO-string in EN locale (default style=medium)', () => {
    const tmpl = Handlebars.compile('{{formatDateTime value}}');
    const out = tmpl({ value: '2026-05-09T14:32:00Z', _locale: 'en' });
    expect(out).toMatch(/May 9, 2026/);
    // UTC-rendered: 14:32Z stays 14:32 (or 2:32 PM). Helper hardcodes timeZone:'UTC',
    // so the test is stable regardless of host TZ.
    expect(out).toMatch(/2:32|14:32/);
  });

  it('formats ISO-string in DE locale', () => {
    const tmpl = Handlebars.compile('{{formatDateTime value}}');
    const out = tmpl({ value: '2026-05-09T14:32:00Z', _locale: 'de' });
    // CLDR `dateStyle: medium` for DE renders as `dd.MM.yyyy` (e.g.
    // "09.05.2026"), not the long-form "9. Mai 2026" — that is Intl's `long`
    // style. Plan-text Rev. 2 line 161 is a documentation slip; the helper
    // follows ICU/CLDR canonical output.
    expect(out).toMatch(/09\.05\.2026/);
    expect(out).toMatch(/14:32/);
  });

  it('renders empty string for null/undefined', () => {
    const tmpl = Handlebars.compile('{{formatDateTime value}}');
    expect(tmpl({ value: null, _locale: 'en' })).toBe('');
    expect(tmpl({ value: undefined, _locale: 'en' })).toBe('');
  });

  it('falls back to DEFAULT_LOCALE if _locale is undefined', () => {
    const tmpl = Handlebars.compile('{{formatDateTime value}}');
    const out = tmpl({ value: '2026-05-09T14:32:00Z' });
    expect(out).toMatch(/May 9, 2026/);
  });
});

describe('formatDate helper (Rev. 2.1 WC-i18n-f18 split)', () => {
  beforeEach(async () => {
    resetI18n();
    await initI18n();
    registerFormatDateHelper();
  });

  it('formats EN locale (date-only, no time)', () => {
    const tmpl = Handlebars.compile('{{formatDate value}}');
    const out = tmpl({ value: '2026-05-09T14:32:00Z', _locale: 'en' });
    expect(out).toMatch(/May 9, 2026/);
    // Date-only must NOT contain the time part.
    expect(out).not.toMatch(/2:32|14:32/);
  });

  it('formats DE locale (date-only)', () => {
    const tmpl = Handlebars.compile('{{formatDate value}}');
    const out = tmpl({ value: '2026-05-09T14:32:00Z', _locale: 'de' });
    // CLDR `dateStyle: medium` DE = `dd.MM.yyyy` (see formatDateTime test
    // above for the same plan-text-vs-CLDR slip).
    expect(out).toMatch(/09\.05\.2026/);
    expect(out).not.toMatch(/14:32/);
  });

  it('renders empty string for null/undefined', () => {
    const tmpl = Handlebars.compile('{{formatDate value}}');
    expect(tmpl({ value: null, _locale: 'en' })).toBe('');
    expect(tmpl({ value: undefined, _locale: 'en' })).toBe('');
  });

  it('falls back to DEFAULT_LOCALE if _locale is undefined', () => {
    const tmpl = Handlebars.compile('{{formatDate value}}');
    const out = tmpl({ value: '2026-05-09T14:32:00Z' });
    expect(out).toMatch(/May 9, 2026/);
  });
});

describe('formatBytes helper', () => {
  beforeEach(async () => {
    resetI18n();
    await initI18n();
    registerFormatBytesHelper();
  });

  it('formats small numbers as plain bytes', () => {
    const tmpl = Handlebars.compile('{{formatBytes value}}');
    expect(tmpl({ value: 0, _locale: 'en' })).toBe('0 B');
    expect(tmpl({ value: 512, _locale: 'en' })).toBe('512 B');
    expect(tmpl({ value: 1024, _locale: 'en' })).toBe('1.00 KB');
  });

  it('formats MB with EN decimal separator', () => {
    const tmpl = Handlebars.compile('{{formatBytes value}}');
    expect(tmpl({ value: 1500000, _locale: 'en' })).toBe('1.43 MB');
  });

  it('formats MB with DE decimal separator (comma)', () => {
    const tmpl = Handlebars.compile('{{formatBytes value}}');
    expect(tmpl({ value: 1500000, _locale: 'de' })).toBe('1,43 MB');
  });

  it('formats bigint TB correctly', () => {
    const tmpl = Handlebars.compile('{{formatBytes value}}');
    expect(tmpl({ value: 1099511627776n, _locale: 'en' })).toBe('1.00 TB');
  });

  it('renders empty string for null/undefined', () => {
    const tmpl = Handlebars.compile('{{formatBytes value}}');
    expect(tmpl({ value: null, _locale: 'en' })).toBe('');
    expect(tmpl({ value: undefined, _locale: 'en' })).toBe('');
  });

  // Rev. 2.1 WC-i18n-f10 boundary test — bigint precision at MAX_SAFE_INTEGER.
  it('PFLICHT WC-i18n-f10: handles bigint at MAX_SAFE_INTEGER boundary without precision loss', () => {
    const tmpl = Handlebars.compile('{{formatBytes value}}');
    // 2^63 - 1 (long-max sentinel) — must produce a sensible EB-magnitude
    // string, not garbage. Pre-Rev-2 Number-coercion lost precision here.
    expect(tmpl({ value: 2n ** 63n - 1n, _locale: 'en' })).toMatch(/^\d+\.\d{2}\s+EB$/);
    // Exactly 9 PB — boundary near MAX_SAFE_INTEGER.
    expect(tmpl({ value: 9n * 1024n ** 5n, _locale: 'en' })).toBe('9.00 PB');
  });

  // Rev. 2.1 WC-i18n-f16: bigint round-half-up consistency with Number-version.
  it('PFLICHT WC-i18n-f16: rounds half-up consistently between bigint and Number inputs', () => {
    const tmpl = Handlebars.compile('{{formatBytes value}}');
    // Same byte-count expressed as bigint vs Number must produce identical output.
    expect(tmpl({ value: 1500000n, _locale: 'en' })).toBe('1.43 MB');
    expect(tmpl({ value: 1500000, _locale: 'en' })).toBe('1.43 MB');
  });
});

describe('view-plugin wires format-helpers', () => {
  it('formatDateTime / formatDate / formatBytes are registered after init', async () => {
    resetI18n();
    await initI18n();
    registerFormatDateTimeHelper();
    registerFormatDateHelper();
    registerFormatBytesHelper();
    expect(Handlebars.helpers).toHaveProperty('formatDateTime');
    expect(Handlebars.helpers).toHaveProperty('formatDate');
    expect(Handlebars.helpers).toHaveProperty('formatBytes');
  });
});
