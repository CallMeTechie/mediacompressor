/**
 * Plan 8d Task 4 (post-review concern #3): shared allowlist + i18n-key map
 * for admin-user flash messages.
 *
 * Used by:
 *  - admin-users-list-page.ts (renders /admin/users?updateflash=... banner)
 *  - admin-user-edit-page.ts  (renders /admin/users/:id?updateflash=... banner)
 *  - admin-user-update-route.ts (uses AdminUserFlashKey to type redirect targets)
 *
 * Single source of truth ensures any new flash-key is wired everywhere in
 * one edit and that the list-page and edit-page banners stay in sync.
 *
 * C1-AD-PR + C3-PR allowlist gate: only known flash-keys render. Any
 * arbitrary `?updateflash=evil` value falls through to `null`.
 */

export const ADMIN_USER_FLASH_KEYS = ['updated', 'csrf-stale'] as const;
export type AdminUserFlashKey = (typeof ADMIN_USER_FLASH_KEYS)[number];

export const ADMIN_USER_FLASH_MAP: ReadonlyMap<
  AdminUserFlashKey,
  { level: 'error' | 'info'; messageKey: string }
> = new Map([
  ['updated', { level: 'info', messageKey: 'flash_user_updated' }],
  ['csrf-stale', { level: 'error', messageKey: 'flash_csrf_stale' }],
]);
