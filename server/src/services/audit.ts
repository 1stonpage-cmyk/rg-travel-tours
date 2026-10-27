/**
 * Task 2 of the core-schema plan: the one way an audit row is created.
 */
import { and, eq } from 'drizzle-orm';
import { AUDIT_ACTOR_TYPES, auditLog } from '../db/schema';
import type { Database, Transaction } from '../db/client';

export type AuditActorType = (typeof AUDIT_ACTOR_TYPES)[number];

export interface AuditEntry {
  actorType: AuditActorType;
  /** Null for `system` and `provider`, which are not rows in any table. */
  actorId: number | null;
  /** Dotted verb: `payment.verified`, `booking.cancelled`, `driver.assigned`. */
  action: string;
  entity: string;
  entityId: number;
  data?: unknown;
}

/**
 * The ONLY way an audit row is created.
 *
 * Takes a transaction handle, never the pool: an audit row written outside
 * the transaction it describes survives a rollback, and then the log claims
 * a payment was verified when it was not. Every caller is already inside a
 * transaction for the change itself — pass that handle through.
 *
 * NEVER put a secret in `data` — no password or PIN hash, no session token,
 * no gateway API key or webhook secret, no card or e-wallet payload. Audit
 * rows are read by admins in the UI and exported in reports, so anything in
 * `data` is effectively published to every admin. Store the identifiers and
 * the amounts that explain the change, and nothing else.
 */
export async function writeAudit(tx: Transaction, entry: AuditEntry): Promise<void> {
  await tx.insert(auditLog).values({
    actorType: entry.actorType,
    actorId: entry.actorId,
    action: entry.action,
    entity: entry.entity,
    entityId: entry.entityId,
    // Explicitly null, not undefined: Drizzle omits an undefined column from
    // the INSERT, which would rely on the column's default instead of saying
    // "there was no context" on purpose.
    data: entry.data ?? null,
    createdAt: new Date(),
  });
}

/**
 * Whether one `(entity, entityId, action)` has already been recorded.
 *
 * **The reader half of "the audit row IS the record that something fired"**
 * (Week 7 Task 14, brief: "No new table. Both sweeps must be idempotent, and
 * the record that one already fired is an `audit_log` row, read back by the
 * sweep"). `jobs/trip-reminders.ts` and `jobs/review-requests.ts` both ask it,
 * which is why it lives here beside `writeAudit` rather than as two private
 * copies: one query shape, one index, one place to fix.
 *
 * Served by `audit_log_entity_idx` (`entity`, `entity_id`); `action` is
 * filtered from the few rows that returns.
 *
 * Takes the pool OR a transaction, unlike `writeAudit`, which insists on a
 * transaction. The asymmetry is deliberate: a row written outside its
 * transaction can survive a rollback and lie, while a READ cannot write
 * anything, so the sweeps are free to pre-filter on the pool and re-ask under
 * the row's own transaction.
 *
 * It is a plain read with no lock, so two sweeps running at the same instant
 * could both see "not yet". The jobs do not rely on it for that: node-cron is
 * registered `noOverlap`, the scheduler runs in ONE PM2 fork-mode process
 * (`jobs/index.ts`), and each job claims a booking by committing this row
 * BEFORE it sends. Concurrency safety here would need a unique index on
 * `audit_log`, which would change an append-only table the whole system
 * writes to.
 */
export async function hasAuditRow(
  db: Database | Transaction,
  where: { entity: string; entityId: number; action: string },
): Promise<boolean> {
  const rows = await db
    .select({ id: auditLog.id })
    .from(auditLog)
    .where(
      and(
        eq(auditLog.entity, where.entity),
        eq(auditLog.entityId, where.entityId),
        eq(auditLog.action, where.action),
      ),
    )
    .limit(1);
  return rows.length > 0;
}
