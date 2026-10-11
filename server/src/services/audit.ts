/**
 * Task 2 of the core-schema plan: the one way an audit row is created.
 */
import { AUDIT_ACTOR_TYPES, auditLog } from '../db/schema';
import type { Transaction } from '../db/client';

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
