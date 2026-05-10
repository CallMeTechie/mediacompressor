import { Prisma, type PrismaClient } from '@mediacompressor/db';
import {
  type AuditAction,
  type AuditTargetType,
  isValidAction,
  isValidTargetType,
} from './action-types.js';

/**
 * Plan 10 Task 2 Rev. 2.1: keys never allowed in audit-payload because they
 * may carry secrets. Plan 8d Task 5 token-leak prevention carry-forward.
 * Rejection is per-key at ANY nesting depth (checked recursively).
 *
 * Concern 6: matched case-insensitively. All entries here are lowercase; the
 * comparison site applies `.toLowerCase()` to the incoming key. This catches
 * adversary-typo variants like `Token`, `TOKEN`, `PassWord`, `apiKey`.
 */
const FORBIDDEN_PAYLOAD_KEYS = new Set<string>([
  'token',
  'password',
  'passwordhash',
  'secret',
  'apikey',
  'sessiontoken',
]);

/**
 * Plan 10 Task 2 Rev. 2.1 WC-audit-11: cap serialized payload size to keep
 * each row inside a single Postgres tuple (no TOAST overhead). Enforced AFTER
 * coercion so the BigInt-→string-blowup is accounted for in the cap.
 */
const MAX_PAYLOAD_BYTES = 4096;

/**
 * Plan 10 Task 2 Rev. 2.1 WC-audit-9: protect against pathological nesting
 * (DoS via deeply-nested input). 10 levels is comfortable for legitimate
 * admin-action payloads (typically <= 3 levels).
 */
const MAX_NESTING_DEPTH = 10;

export interface RecordAuditEventInput {
  actorUserId: string;
  action: AuditAction;
  targetType: AuditTargetType;
  targetId: string;
  payload?: Record<string, unknown>;
}

export interface RecordAuditEventResult {
  id: string;
  createdAt: Date;
}

/**
 * JsonValue alias: superset of Prisma.InputJsonValue that also permits `null`.
 * Used as the return-type of the recursive coercers so we don't need a
 * `null as unknown as Prisma.InputJsonValue` double-cast for null-leaves.
 * Prisma's JSON column accepts `null` as a valid JSON value (distinct from
 * SQL NULL / `Prisma.DbNull`), so the boundary-cast at the Prisma call-site
 * is safe (Concern 4 fix).
 */
type JsonValue = Prisma.InputJsonValue | null;

/**
 * Coerce a single value to JSON-safe form.
 * - BigInt to string (Plan 8d Task 4 Concern 6 Lehre: JSON.stringify crashes on bigint).
 * - null/undefined to null.
 * - function/symbol: REJECTED explicitly (Concern 3 fix — was silently dropped
 *   by JSON.stringify previously).
 * - Date: ISO-string (Concern 2 fix — common audit-payload value-type).
 * - Non-plain-object class-instances (Map, Set, RegExp, custom): REJECTED
 *   (Concern 2 fix — was silently coerced to `{}` previously).
 * - Array: recurse on each item, with cycle-tracking via `seen` (Concern 1
 *   fix — previously array-cycles only failed via depth-limit).
 * - Plain object: delegate to coercePayload (forbidden-key check + recurse).
 * - Primitives: pass through.
 *
 * Cycle-detection via `seen` set; depth-limit via `depth` counter.
 */
function coerceValue(
  value: unknown,
  depth: number,
  seen: Set<unknown>,
): JsonValue {
  if (depth > MAX_NESTING_DEPTH) {
    throw new Error(`audit payload exceeds max nesting depth (${MAX_NESTING_DEPTH})`);
  }
  if (typeof value === 'bigint') return value.toString();
  if (value === null || typeof value === 'undefined') {
    return null;
  }
  // Concern 3: reject function/symbol explicitly (JSON.stringify would drop
  // them silently, masking auditor-intent). Placed AFTER bigint and null
  // checks so legitimate primitives still pass through.
  if (typeof value === 'function' || typeof value === 'symbol') {
    throw new Error(`unsupported payload value-type: ${typeof value}`);
  }
  if (Array.isArray(value)) {
    // Concern 1: track arrays in `seen` to detect self-referential arrays
    // explicitly. Without this, a cyclic array would only fail via the
    // depth-limit, masking the real cause.
    if (seen.has(value)) {
      throw new Error('audit payload contains cyclic reference');
    }
    seen.add(value);
    try {
      return value.map((item) => coerceValue(item, depth + 1, seen));
    } finally {
      seen.delete(value);
    }
  }
  if (typeof value === 'object') {
    if (seen.has(value)) {
      throw new Error('audit payload contains cyclic reference');
    }
    // Concern 2: Date → ISO-string (common audit-value-type).
    if (value instanceof Date) {
      return value.toISOString();
    }
    // Concern 2: reject all other class-instances (Map, Set, RegExp, custom
    // classes). Plain objects have Object.prototype as their prototype; null-
    // prototype objects are also allowed (createObject(null) is plain-data).
    const proto = Object.getPrototypeOf(value);
    if (proto !== Object.prototype && proto !== null) {
      const ctorName =
        (value as { constructor?: { name?: string } }).constructor?.name ?? 'unknown class';
      throw new Error(`unsupported payload value-type: ${ctorName}`);
    }
    seen.add(value);
    try {
      return coercePayload(value as Record<string, unknown>, depth + 1, seen);
    } finally {
      seen.delete(value);
    }
  }
  return value as Prisma.InputJsonValue;
}

/**
 * Coerce a top-level/nested object: enforce FORBIDDEN_PAYLOAD_KEYS at this
 * level, then coerce each value recursively.
 *
 * Rev. 2.1 WC-audit-16: `seen.add(payload)` is called AT ENTRY (before
 * iterating children), so 2-step mutual cycles (a.b -> b, b.a -> a) trigger
 * the explicit `cyclic reference`-error rather than only failing via the
 * depth-limit. Without this, the first cycle-completion would only be
 * detected once depth reached MAX_NESTING_DEPTH, masking the real cause.
 */
function coercePayload(
  payload: Record<string, unknown>,
  depth = 0,
  seen: Set<unknown> = new Set(),
): JsonValue {
  if (depth > MAX_NESTING_DEPTH) {
    throw new Error(`audit payload exceeds max nesting depth (${MAX_NESTING_DEPTH})`);
  }
  // Concern 5: when coerceValue calls us, it already added `payload` to `seen`
  // for its own cycle-detection. Re-adding here is idempotent (Set semantics).
  // We add anyway to support direct top-level coercePayload calls (the public
  // entry-point), so 2-step cycles starting at the root are caught explicitly
  // (WC-audit-16). The two trackers are deliberately redundant for clarity at
  // each layer — neither layer owns "global" cycle-state.
  seen.add(payload);
  try {
    // Use Object.fromEntries instead of bracket-assignment so eslint's
    // `security/detect-object-injection` rule doesn't flag the accumulator.
    // FORBIDDEN_PAYLOAD_KEYS check still runs before each entry is built.
    const entries: Array<[string, JsonValue]> = [];
    for (const [key, value] of Object.entries(payload)) {
      // Concern 6: case-insensitive lookup. Preserve original-case in the
      // error-message for debugging.
      if (FORBIDDEN_PAYLOAD_KEYS.has(key.toLowerCase())) {
        throw new Error(`disallowed payload key: "${key}" (reserved for secrets)`);
      }
      entries.push([key, coerceValue(value, depth + 1, seen)]);
    }
    return Object.fromEntries(entries) as Prisma.InputJsonValue;
  } finally {
    seen.delete(payload);
  }
}

/**
 * Record an admin-action audit-event. Validates action + target-type against
 * the const-tuple allowlists, coerces the payload (BigInt-safe, forbidden-key
 * rejection, cycle-detection, depth-limit, 4KB cap), then inserts one row
 * into the AuditEvent table.
 *
 * Throws on: unknown action/target-type, forbidden payload-key at any depth,
 * cyclic payload, payload nesting > 10, payload > 4096 bytes after coercion,
 * Prisma FK-violation (invalid actorUserId).
 *
 * Plan 10 Task 2 Rev. 2.1 WC-audit-14: This is the ONLY mutation-API exposed
 * by `@mediacompressor/audit`. NO updateAuditEvent / deleteAuditEvent: audit
 * trail integrity is application-enforced.
 */
export async function recordAuditEvent(
  prisma: PrismaClient,
  input: RecordAuditEventInput,
): Promise<RecordAuditEventResult> {
  if (!isValidAction(input.action)) {
    throw new Error(`unknown audit-action: "${input.action}"`);
  }
  if (!isValidTargetType(input.targetType)) {
    throw new Error(`unknown audit-target-type: "${input.targetType}"`);
  }

  // Concern 4: coercePayload returns JsonValue (which permits null at leaf).
  // At this boundary we cast to InputJsonValue, which is safe: the recursive
  // coercer's null-leaves are valid JSON-column values; `input.payload`
  // itself is `Record<string, unknown>` so `coerced` here is an object/array,
  // never a top-level null.
  let coerced: Prisma.InputJsonValue | typeof Prisma.DbNull = Prisma.DbNull;
  if (input.payload) {
    coerced = coercePayload(input.payload) as Prisma.InputJsonValue;
    const serialized = JSON.stringify(coerced);
    if (serialized.length > MAX_PAYLOAD_BYTES) {
      throw new Error(
        `audit payload exceeds ${MAX_PAYLOAD_BYTES} bytes (got ${serialized.length})`,
      );
    }
  }

  const created = await prisma.auditEvent.create({
    data: {
      actorUserId: input.actorUserId,
      action: input.action,
      targetType: input.targetType,
      targetId: input.targetId,
      payload: coerced,
    },
    select: { id: true, createdAt: true },
  });
  return created;
}
