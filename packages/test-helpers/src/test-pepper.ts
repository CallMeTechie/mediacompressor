/**
 * H1-Fix: Unified Test-Pepper across ALL integration test files.
 * Using `'c'.repeat(32)` matches the Plan-4 test-config convention.
 */
export const TEST_API_KEY_PEPPER = 'c'.repeat(32);
export const TEST_SESSION_SECRET = 'a'.repeat(32);
export const TEST_CSRF_SECRET = 'b'.repeat(32);
