export const AUDIT_ACTIONS = ['invite_create', 'invite_revoke', 'user_update'] as const;
export type AuditAction = (typeof AUDIT_ACTIONS)[number];

export const AUDIT_TARGET_TYPES = ['invite', 'user'] as const;
export type AuditTargetType = (typeof AUDIT_TARGET_TYPES)[number];

export function isValidAction(value: string): value is AuditAction {
  return (AUDIT_ACTIONS as readonly string[]).includes(value);
}

export function isValidTargetType(value: string): value is AuditTargetType {
  return (AUDIT_TARGET_TYPES as readonly string[]).includes(value);
}
