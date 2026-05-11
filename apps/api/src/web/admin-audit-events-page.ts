import { z } from 'zod';
import type { FastifyPluginAsync } from 'fastify';
import { AUDIT_ACTIONS, type AuditAction } from '@mediacompressor/audit';

/**
 * Plan 10 Task 4: GET /admin/audit-events -- paginated audit-trail list.
 *
 * Renders a read-only table of AuditEvent rows ordered by createdAt DESC
 * (with id as tie-break per PFLICHT WC-audit-5). Composable filters via
 * querystring: `actorId` (UUID) and `action` (canonical EN enum from
 * AUDIT_ACTIONS). Pagination via opaque cursor (createdAt-ms + id).
 *
 * Auth-gate: `app.requireAdminSession` (Plan 8d Task 1):
 *  - No session: 303 to /login (delegated by wrapped requireSession).
 *  - Valid non-admin: 403 HTML (no admin-existence-leak).
 *  - Valid admin: handler runs.
 *
 * Cache-Control: no-store, max-age=0 -- audit-trail data is sensitive and
 * per-request; never browser/proxy-cached. Mirrors C5-Rev2 from Plan 8b.
 *
 * Data access: reads AuditEvent directly via Prisma (NO inner JSON-API for
 * audit-events exists in Plan 10; Plan 11+ may add one). N+1 prevented via
 * Prisma `include: { actor: { select: { email: true } } }`.
 *
 * **Cursor encoding (PFLICHT WC-audit-5):** opaque base64url of
 * `<createdAtMs>:<id>`. Decoding tolerates malformed cursors (silently falls
 * back to first-page) -- the admin-only path never trusts a forged cursor.
 *
 * **GDPR sentinel-user (Plan 10 Task 1 WC-audit-15):** when actorUserId =
 * `00000000-0000-0000-0000-000000000000`, the view-model substitutes the
 * actor-email with the i18n key `audit_events_anonymized_actor` so erased
 * accounts render as "(anonymized account)" / "(anonymisierter Account)".
 *
 * fp-wrap rule: this plugin does NOT decorate anything -> NOT fp-wrapped.
 */

const SENTINEL_USER_ID = '00000000-0000-0000-0000-000000000000';

const Query = z.object({
  cursor: z.string().optional(),
  actorId: z.string().uuid().optional(),
  // Action filter MUST be one of the canonical EN AUDIT_ACTIONS values
  // (Translation Discipline: filter-VALUE is never translated; only the
  // display LABEL is, via the tAuditAction Handlebars helper). z.enum
  // rejects arbitrary `?action=evil` injection at parse-time -- the
  // narrowed type then guarantees we can pass it straight to Prisma.
  action: z.enum(AUDIT_ACTIONS).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

/**
 * Opaque cursor: `<createdAtMs>:<uuid>`, base64url-encoded. Composite key
 * (createdAt, id) defeats the WC-audit-5 tie-break problem when several
 * events land in the same createdAt millisecond.
 */
function encodeCursor(createdAt: Date, id: string): string {
  return Buffer.from(`${createdAt.getTime()}:${id}`, 'utf8').toString('base64url');
}

function decodeCursor(
  value: string | undefined,
): { createdAtMs: number; id: string } | null {
  if (!value) return null;
  try {
    const decoded = Buffer.from(value, 'base64url').toString('utf8');
    const colonIdx = decoded.indexOf(':');
    if (colonIdx < 1) return null;
    const msStr = decoded.slice(0, colonIdx);
    const id = decoded.slice(colonIdx + 1);
    const ms = Number(msStr);
    if (!Number.isFinite(ms) || ms < 0) return null;
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) {
      return null;
    }
    return { createdAtMs: ms, id };
  } catch {
    return null;
  }
}

export const adminAuditEventsPagePlugin: FastifyPluginAsync = async (app) => {
  const { prisma } = app.deps;

  app.get(
    '/admin/audit-events',
    {
      preHandler: app.requireAdminSession,
      schema: { querystring: Query },
    },
    async (req, reply) => {
      reply.header('cache-control', 'no-store, max-age=0');
      const q = req.query as z.infer<typeof Query>;

      const decoded = decodeCursor(q.cursor);

      // Composite WHERE: AND of all set filters + cursor predicate.
      //
      // Cursor predicate (WC-audit-5 tie-break): rows where
      //   createdAt < cursorCreatedAt
      //   OR (createdAt = cursorCreatedAt AND id < cursorId)
      // -- assuming orderBy DESC. Postgres can use the
      // [actorUserId|action|createdAt(desc)] indexes for the createdAt-half;
      // the id-half tie-break is rare enough that an in-memory filter is fine.
      const where: Record<string, unknown> = {};
      if (q.actorId !== undefined) where.actorUserId = q.actorId;
      if (q.action !== undefined) where.action = q.action;
      if (decoded !== null) {
        const cursorDate = new Date(decoded.createdAtMs);
        where.OR = [
          { createdAt: { lt: cursorDate } },
          { createdAt: cursorDate, id: { lt: decoded.id } },
        ];
      }

      // Fetch limit+1 so we can detect "has more" without a separate COUNT.
      const events = await prisma.auditEvent.findMany({
        where,
        // ORDER BY createdAt DESC, id DESC -- Plan 10 Task 1's indices
        // [createdAt(desc)], [actorUserId, createdAt(desc)], etc. cover the
        // createdAt-half; the id-secondary is a stable tie-breaker enforced
        // by the schema's @id @db.Uuid (PRIMARY KEY uses btree(id)).
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: q.limit + 1,
        include: {
          actor: {
            select: { email: true, id: true },
          },
        },
      });

      const hasMore = events.length > q.limit;
      const slice = events.slice(0, q.limit);
      const last = slice[slice.length - 1];
      const nextCursor =
        hasMore && last !== undefined ? encodeCursor(last.createdAt, last.id) : null;

      // Pre-translate the anonymized-actor label once per-render (i18next
      // round-trip is non-trivial -- one lookup beats N look-ups inside the
      // {{#each}} loop).
      const anonymizedActorLabel = app.i18n.t('audit_events_anonymized_actor', {
        lng: req.locale,
        ns: 'admin',
      }) as string;

      // View-model: pre-format the payload as compact JSON for the table-cell.
      // BigInt-safe (Plan 8d Task 4 Lehre): recordAuditEvent already coerces
      // BigInt -> string before persistence, so JSON.stringify cannot crash
      // on raw BigInts here. Defensive fallback returns '' for null/undefined.
      //
      // The payload string is passed to Handlebars as a plain string -- the
      // `{{ }}` default-escape will HTML-escape any `<script>` content
      // (PFLICHT WC-audit-4) without us doing anything special.
      const eventRows = slice.map((e) => {
        const isSentinel = e.actorUserId === SENTINEL_USER_ID;
        const actorEmail = isSentinel
          ? anonymizedActorLabel
          : (e.actor?.email ?? anonymizedActorLabel);
        let payloadJson = '';
        if (e.payload !== null && e.payload !== undefined) {
          try {
            payloadJson = JSON.stringify(e.payload);
          } catch {
            payloadJson = '';
          }
        }
        return {
          id: e.id,
          // ISO-8601 so the template's `<time datetime="{{createdAt}}">`
          // attribute is HTML-spec-compliant (assistive-tech parses it as a
          // machine-readable timestamp). `formatDateTime` accepts strings
          // too (`new Date(String(value))`), so the human-readable label
          // continues to render correctly.
          createdAt: e.createdAt.toISOString(),
          actorUserId: e.actorUserId,
          actorEmail,
          action: e.action,
          targetType: e.targetType,
          targetId: e.targetId,
          payloadJson,
        };
      });

      return reply.view('admin-audit-events', {
        title: app.i18n.t('page_title_audit_events', { lng: req.locale, ns: 'admin' }),
        events: eventRows,
        nextCursor,
        // Filter view-model: passes the active filters back to the template
        // so pagination links can preserve them AND filter-buttons can
        // re-emit them when toggling action (PFLICHT WC-audit-17).
        currentAction: q.action ?? null,
        currentActorId: q.actorId ?? null,
        // Canonical EN action list for filter-button rendering. Cast keeps
        // template-data typed without leaking the readonly-ness to the view.
        auditActions: AUDIT_ACTIONS as readonly AuditAction[],
      });
    },
  );
};
