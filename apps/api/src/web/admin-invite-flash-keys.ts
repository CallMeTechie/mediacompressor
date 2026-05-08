/**
 * Plan 8d Task 5: shared allowlist + i18n-key map for admin-invite flash
 * messages. Mirrors the admin-user-flash-keys.ts pattern from Task 4.
 *
 * Used by:
 *  - admin-invites-list-page.ts (renders /admin/invites?updateflash=... banner)
 *  - admin-invite-create-route.ts (uses `csrf-stale` redirect on inner 403)
 *  - admin-invite-revoke-route.ts (uses `revoked` / `csrf-stale` redirect targets)
 *
 * Single source of truth ensures any new flash-key is wired everywhere in
 * one edit. C1-AD-PR + C3-PR allowlist gate: only known flash-keys render.
 * Any arbitrary `?updateflash=evil` value falls through to `null`.
 */

export const ADMIN_INVITE_FLASH_KEYS = ['created', 'revoked', 'csrf-stale'] as const;
export type AdminInviteFlashKey = (typeof ADMIN_INVITE_FLASH_KEYS)[number];

export const ADMIN_INVITE_FLASH_MAP: ReadonlyMap<
  AdminInviteFlashKey,
  { level: 'error' | 'info'; messageKey: string }
> = new Map([
  ['created', { level: 'info', messageKey: 'flash_invite_created' }],
  ['revoked', { level: 'info', messageKey: 'flash_invite_revoked' }],
  ['csrf-stale', { level: 'error', messageKey: 'flash_csrf_stale' }],
]);
