// Plan 10 Task 2 Rev. 2.1 WC-audit-14: ONLY `recordAuditEvent` is exported as
// a mutation-API. NO updateAuditEvent / deleteAuditEvent functions exist:
// audit-trail integrity is application-enforced (see migration.sql comment).
export * from './action-types.js';
export * from './audit-event.js';
