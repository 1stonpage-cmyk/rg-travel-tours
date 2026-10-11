# Core Schema Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Create the 16 remaining `BUILD_SPEC.md` §10 tables and a provider-neutral payment layer, so that bookings, payments, fleet, roles and audit have a schema to build weeks 3–7 on.

**Architecture:** One Drizzle migration per dependency wave, so foreign keys always point at tables that already exist. Money stays `INT` centavos and time stays UTC `DATETIME` at the column level, not by convention. Payments are provider-neutral from the first migration: a `PaymentProvider` interface in `server/src/services/payments/` owns everything gateway-specific, PayMongo implements it, Xendit is a stub that throws, and the tables never learn either name beyond an enum value.

**Tech Stack:** Drizzle ORM + drizzle-kit + mysql2, MySQL 8.0.46, Zod v4 (shared), Vitest, Express 5 + tRPC v11. No new dependencies — see Global Constraints.

**Spec:** `docs/BUILD_SPEC.md` (§5 pricing/capacity/holds, §6 checkout & payments, §7 customer portal, §8 driver portal, §9 admin roles, §10 database tables, §12 security checklist). The plan argues from the spec; executors read both.

**Status:** PLAN ONLY — awaiting owner approval. No table in this document may be created, altered
or migrated until that approval is given.

**Revision 2, 2026-10-11.** Owner answered Q4 (deposit rounds UP to a whole peso), Q6 (coupon
discount split into `discount_type` + `percent_bp` + `amount_centavos` with a database CHECK) and
Q7 (capacity = `MIN(groups_per_day, vans free that day across all tours)`, never auto-overbook,
admin override audited), and approved an app-level Express error handler. Tasks 5, 19 and 20 carry
those. **The Q7 answer raised one new blocking question — Q14, the cross-tour fleet lock — because
the per-tour lock the spec designed cannot enforce a fleet-wide limit.** Nine questions remain open.

## Global Constraints

Copied verbatim from `CLAUDE.md` and `docs/BUILD_SPEC.md`. Every task's requirements implicitly include this section.

- **Money:** integers in **centavos** everywhere — DB, API, logic. Format only at display.
- **Time:** store **UTC**; display and compute business dates in **Asia/Manila**.
- **IDs:** auto-increment internally. Public booking refs are random and non-sequential (`RG-7KQ4M9`).
- **Soft deletes:** use `is_active` / status fields for tours, vans, drivers, users. **Never hard-delete bookings or payments.**
- **Audit:** every payment, refund, status change, and assignment writes to `audit_log`.
- **Validation:** Zod on every input, schemas shared from `/shared`.
- **DO NOT** trust prices, totals, deposits, or discounts sent from the browser. The server computes all money.
- **DO NOT** mark a booking paid from the client side or from a redirect URL. Only a verified webhook or an admin approval does that.
- **DO NOT** store card numbers, CVV, or e-wallet credentials anywhere. The gateway handles them.
- **DO NOT** let one role reach another role's endpoints. Hiding a button is not access control.
- **DO NOT** add libraries, services, or features not listed in the spec without asking. **No Xendit SDK, no PayMongo SDK** — both gateways are plain `fetch` against documented REST endpoints. Allowed set remains: `drizzle-orm`, `drizzle-kit`, `mysql2`, `@trpc/*`, `@tanstack/react-query`, `zod`, `express-rate-limit`.
- **DO NOT** use red anywhere in the UI.
- **DO NOT** use ports 5173 or 3000. Kong PMS shares this machine and this MySQL server.
- Local database is **`rg_travel`**; tests use **`rg_travel_test`**. `server/src/db/guard.ts` enforces this and must not be weakened.
- Never log or print `DATABASE_URL`, any password, or any gateway secret.
- Secrets live only in `.env`, never in client code and never in the database.
- **Every new test must be proven able to fail.** Break the code it covers, confirm the test goes red, then restore. A test that cannot fail is a bug — log it in `docs/BUGS_LOG.md`. Security controls and destructive operations must fail closed, with a test for the failure path.
- **Verify before pushing — all five, in this order:** `pnpm lint` · `pnpm typecheck` · `pnpm test` · `pnpm format:check` · `ALLOW_PLACEHOLDER_BUILD=1 pnpm build`.

---

## Scope check

This plan covers one subsystem — the transactional core — and deliberately stops at the schema plus the payment service seam. It does **not** build checkout UI, the portals, the admin screens, or the cron jobs; those are weeks 3–7 and each needs its own plan. What this plan delivers on its own is a migrated database, typed Drizzle models, the money/ref/audit helpers, the `PaymentProvider` seam with one working implementation, and the test suite that pins every constraint above.

Phase 3 (payments) is the part most likely to be wanted as a separate plan later. It is kept here because `payments` and `payment_events` are two of the 16 tables and their column shapes are exactly what the provider abstraction dictates — splitting them would mean designing the tables twice.

---

## Current state

12 of the spec's 28 tables exist: `destinations`, `tours`, `tour_images`, `tour_price_tiers`, `tour_itinerary_stops`, `tour_addons`, `tour_blocked_dates`, `packages`, `reviews`, `inquiries`, `newsletter_subscribers`, `settings` (plus `__drizzle_migrations`). Verified against `information_schema` on 2026-10-10.

Two existing columns become real foreign keys in this plan: `reviews.tour_id` already has one, but `reviews.booking_id` is a bare nullable `int` and gains an FK in Wave 3; `inquiries.package_id` is likewise bare and gains one in Wave 1.

---

## File structure

| File                                                 | Responsibility                                                                                                                                                                                  |
| ---------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `server/src/db/schema.ts`                            | **Modify.** All Drizzle table definitions. Already holds the 12 existing tables; gains 16 more. Single file because drizzle-kit reads one schema and the existing codebase keeps them together. |
| `server/src/db/migrations/0002_*.sql` … `0005_*.sql` | **Generated**, one per dependency wave. Never hand-written.                                                                                                                                     |
| `shared/src/booking.ts`                              | **Create.** `bookingRefSchema`, booking/payment status enums and Zod schemas shared by client and server.                                                                                       |
| `server/src/services/booking-ref.ts`                 | **Create.** `generateBookingRef()` and its collision-retry insert helper.                                                                                                                       |
| `server/src/services/audit.ts`                       | **Create.** `writeAudit()` — the one way an audit row is created.                                                                                                                               |
| `server/src/services/payments/types.ts`              | **Create.** `PaymentProvider` interface and its input/result types. No gateway specifics.                                                                                                       |
| `server/src/services/payments/paymongo.ts`           | **Create.** PayMongo implementation of `PaymentProvider`.                                                                                                                                       |
| `server/src/services/payments/xendit.ts`             | **Create.** Xendit stub — every method throws `ProviderNotEnabledError`.                                                                                                                        |
| `server/src/services/payments/registry.ts`           | **Create.** `getProvider(name)` and `getActiveProvider()`; the only place a provider name maps to an implementation.                                                                            |
| `server/src/services/payments/record-payment.ts`     | **Create.** The single transaction that inserts a `payments` row, updates the booking, and writes audit. Called by the webhook route and by admin approval — nothing else.                      |
| `server/src/routers/webhooks/index.ts`               | **Create.** `POST /api/webhooks/:provider`, raw-body, signature-verified, idempotent.                                                                                                           |
| `server/src/middleware/require-role.ts`              | **Create.** Role gate for admin procedures.                                                                                                                                                     |
| `server/src/__tests__/*.test.ts`                     | **Create.** One file per task, named in each task below.                                                                                                                                        |

---

## The 16 tables, mapped to the spec

| #   | Table                  | Spec section                                     | Why it exists                                    |
| --- | ---------------------- | ------------------------------------------------ | ------------------------------------------------ |
| 1   | `users`                | §10, §9 Roles & permissions                      | Admin accounts; `role` drives every admin gate   |
| 2   | `sessions`             | §10, §7 portal login, §8 driver login            | One table for three subject types                |
| 3   | `vans`                 | §10, §9 Vans                                     | Fleet; capacity feeds the §5 capacity check      |
| 4   | `drivers`              | §10, §9 Drivers, §8 driver portal                | PIN login, lockout, leave                        |
| 5   | `driver_leaves`        | §10                                              | Makes a driver unavailable for a date range      |
| 6   | `coupons`              | §10, §9 Coupons                                  | Percent/fixed discount with window and usage cap |
| 7   | `audit_log`            | §10, Conventions                                 | Every payment, refund, status change, assignment |
| 8   | `tour_date_slots`      | §10, §5 Concurrency                              | Lock row for `SELECT … FOR UPDATE`               |
| 9   | `bookings`             | §10, §5, §6                                      | The central record                               |
| 10  | `booking_addons`       | §10                                              | Add-on lines, price-snapshotted                  |
| 11  | `booking_notes`        | §10, §9 Bookings                                 | Internal admin notes                             |
| 12  | `coupon_redemptions`   | §10                                              | One row per coupon use; enforces the cap         |
| 13  | `payments`             | §10, §6                                          | Provider-neutral money movement, both directions |
| 14  | `payment_events`       | §10 (`paymongo_events`), §6 Idempotency, **B1a** | Webhook idempotency across all providers         |
| 15  | `trip_checkpoints`     | §10, §8 Itinerary check-ins                      | Per-stop arrival timestamps                      |
| 16  | `review_helpful_votes` | §10, §4 Reviews block                            | One helpful vote per browser                     |

`payment_events` replaces the spec's `paymongo_events` — see **B1b / spec amendment** below. That rename is the only deviation from the §10 table list, and it is owner-approved.

---

## Migration order and foreign keys

Four waves. A wave may only reference tables created in an earlier wave or in the existing 12. Each wave is one generated migration, applied in order.

```
WAVE 1  (no FKs to new tables)
  users            —
  vans             —
  drivers          —
  coupons          —
  audit_log        —           (actor_id is polymorphic: NO FK, see note)
  tour_date_slots  → tours
  payment_events   —           (provider + provider_event_id only)
  inquiries.package_id → packages          [FK added to an existing table]

WAVE 2
  sessions         → users (nullable), drivers (nullable)   (polymorphic, see note)
  driver_leaves    → drivers
  bookings         → tours, vans (nullable), drivers (nullable), coupons (nullable)

WAVE 3
  booking_addons      → bookings, tour_addons
  booking_notes       → bookings, users
  coupon_redemptions  → coupons, bookings
  payments            → bookings, users (verified_by, nullable), drivers (collected_by, nullable)
  trip_checkpoints    → bookings, tour_itinerary_stops (nullable — null means "trip start")
  reviews.booking_id  → bookings                            [FK added to an existing table]

WAVE 4
  review_helpful_votes → reviews
```

**Polymorphic columns get no FK, deliberately.** `audit_log.actor_id` and `sessions.subject_id` each point at one of several tables depending on a sibling `*_type` column, which MySQL cannot express as a foreign key. They are plain indexed `int`s. The integrity that a FK would have given is enforced in the service layer and pinned by tests (Tasks 2 and 7). Do not invent a `user_id`/`driver_id` column pair to fake it — that puts two nullable FKs on every audit row and still allows both to be set at once.

**`ON DELETE` is `RESTRICT` (Drizzle's `no action`) everywhere.** Nothing in this schema cascades. Bookings and payments are never hard-deleted (Global Constraints), and a cascade is precisely the mechanism that would quietly delete them. Soft-delete via `is_active` / `status` instead.

---

## Conventions, and how each is enforced

| Convention                                    | Mechanism                                                                                                                                       | Pinned by                                                                                                                    |
| --------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| Money is centavos                             | Every money column is `int`, named `*_centavos`, with no `decimal` anywhere                                                                     | Task 15 — a guard test greps `schema.ts` for `decimal(`/`float(`/`double(` and for money-ish column names lacking the suffix |
| Times are UTC                                 | Every timestamp is `datetime` (never `timestamp`, which MySQL converts per session `time_zone`)                                                 | Task 15 — same guard test forbids `timestamp(` in `schema.ts`                                                                |
| Business dates are Manila                     | `date`-typed columns (`tour_date`, leave dates, blocked dates) carry a civil date with no zone; conversion happens in `shared/src/time.ts` only | Task 10                                                                                                                      |
| Refs are random                               | `generateBookingRef()` uses crypto randomness over an unambiguous alphabet                                                                      | Task 9                                                                                                                       |
| No hard delete of bookings/payments           | No repository function deletes them, and a guard test forbids the call shape in source                                                          | Task 15                                                                                                                      |
| Audit on every money/status/assignment change | `writeAudit()` is called inside the same transaction as the change                                                                              | Tasks 7, 12, 13                                                                                                              |
| Role isolation                                | `requireRole()` on every admin procedure                                                                                                        | Task 16 — a test per role per area                                                                                           |

---

## Phase 1 — Foundation tables (Wave 1)

### Task 1: `users`, and the role enum

**Files:**

- Modify: `server/src/db/schema.ts`
- Create: `shared/src/roles.ts`
- Test: `server/src/__tests__/schema-users.test.ts`

**Interfaces:**

- Produces: `users` table; `ADMIN_ROLES` (`readonly ['owner','dispatcher','finance']`), `type AdminRole`, `adminRoleSchema` from `@rg/shared`.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from 'vitest';
import { ADMIN_ROLES, adminRoleSchema } from '@rg/shared';

describe('admin roles', () => {
  it('is exactly the three roles the permission matrix uses', () => {
    expect([...ADMIN_ROLES]).toEqual(['owner', 'dispatcher', 'finance']);
  });

  it('rejects a role outside the matrix', () => {
    expect(adminRoleSchema.safeParse('admin').success).toBe(false);
    expect(adminRoleSchema.safeParse('superuser').success).toBe(false);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `pnpm --filter @rg/server test schema-users`
Expected: FAIL — `ADMIN_ROLES` is not exported from `@rg/shared`.

- [ ] **Step 3: Add the shared role module**

```ts
// shared/src/roles.ts
import { z } from 'zod';

/**
 * The three admin roles in BUILD_SPEC §9's permission matrix, and nothing
 * else. There is deliberately no "admin" or "superuser": `owner` is the
 * all-areas role, and adding a fourth silently grants it nothing until the
 * matrix in require-role.ts is updated too.
 */
export const ADMIN_ROLES = ['owner', 'dispatcher', 'finance'] as const;
export type AdminRole = (typeof ADMIN_ROLES)[number];
export const adminRoleSchema = z.enum(ADMIN_ROLES);
```

Re-export it from `shared/src/index.ts` alongside the existing exports.

- [ ] **Step 4: Add the table**

```ts
// server/src/db/schema.ts
export const users = mysqlTable(
  'users',
  {
    id: int('id').autoincrement().primaryKey(),
    name: varchar('name', { length: 160 }).notNull(),
    email: varchar('email', { length: 200 }).notNull().unique(),
    passwordHash: varchar('password_hash', { length: 255 }).notNull(),
    role: mysqlEnum('role', ADMIN_ROLES).notNull(),
    isActive: boolean('is_active').notNull().default(true),
    lastLoginAt: datetime('last_login_at', { mode: 'date' }),
    createdAt: datetime('created_at', { mode: 'date' }).notNull(),
    updatedAt: datetime('updated_at', { mode: 'date' }).notNull(),
  },
  (t) => [index('users_role_active_idx').on(t.role, t.isActive)],
);
```

`password_hash` is 255 to fit an argon2id encoded hash with room to spare; bcrypt's 60 would fit too, and the spec allows either.

- [ ] **Step 5: Run the test, then the five checks, then commit**

```bash
git add shared/src/roles.ts shared/src/index.ts server/src/db/schema.ts server/src/__tests__/schema-users.test.ts
git commit -m "feat(db): users table and the three-role enum"
```

**✅ DONE 1**

---

### Task 2: `audit_log`, and `writeAudit()`

**Files:**

- Modify: `server/src/db/schema.ts`
- Create: `server/src/services/audit.ts`
- Test: `server/src/__tests__/audit.test.ts`

**Interfaces:**

- Consumes: `users` (Task 1).
- Produces: `audit_log` table; `writeAudit(tx, entry): Promise<void>` where `entry` is `{ actorType: AuditActorType; actorId: number | null; action: string; entity: string; entityId: number; data?: unknown }`, and `AUDIT_ACTOR_TYPES = ['user','customer','driver','system'] as const`.

The `tx` parameter is a Drizzle transaction handle, not the pool. That is the point of this function: an audit row that is written outside the transaction it describes can survive a rollback and record something that never happened.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { getDb } from '../db/client';
import { auditLog } from '../db/schema';
import { writeAudit } from '../services/audit';

describe('writeAudit', () => {
  it('records an actor, an action, an entity and a UTC timestamp', async () => {
    const db = getDb();
    await db.transaction(async (tx) => {
      await writeAudit(tx, {
        actorType: 'user',
        actorId: 1,
        action: 'payment.verified',
        entity: 'payments',
        entityId: 42,
        data: { amountCentavos: 189000 },
      });
    });

    const [rows] = await db.execute(
      sql`SELECT actor_type, actor_id, action, entity, entity_id, data FROM audit_log WHERE entity_id = 42`,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].action).toBe('payment.verified');
    expect(JSON.parse(String(rows[0].data))).toEqual({ amountCentavos: 189000 });
  });

  it('rolls the audit row back with the transaction it describes', async () => {
    const db = getDb();
    await expect(
      db.transaction(async (tx) => {
        await writeAudit(tx, {
          actorType: 'system',
          actorId: null,
          action: 'booking.expired',
          entity: 'bookings',
          entityId: 999,
        });
        throw new Error('simulated failure after the audit write');
      }),
    ).rejects.toThrow('simulated failure');

    const [rows] = await db.execute(sql`SELECT id FROM audit_log WHERE entity_id = 999`);
    expect(rows, 'an audit row survived a rolled-back transaction').toHaveLength(0);
  });
});
```

The second test is the one that matters. Prove it can fail by making `writeAudit` take the pool instead of `tx` — the row then survives the rollback and the assertion goes red.

- [ ] **Step 2: Run it and watch it fail**

Run: `pnpm --filter @rg/server test audit`
Expected: FAIL — `../services/audit` does not exist.

- [ ] **Step 3: Add the table**

```ts
export const AUDIT_ACTOR_TYPES = ['user', 'customer', 'driver', 'system'] as const;

export const auditLog = mysqlTable(
  'audit_log',
  {
    id: int('id').autoincrement().primaryKey(),
    /** Which table `actor_id` points at. No FK — see "Polymorphic columns" in the plan. */
    actorType: mysqlEnum('actor_type', AUDIT_ACTOR_TYPES).notNull(),
    /** Null for `system` (cron, webhook with no human behind it). */
    actorId: int('actor_id'),
    /** Dotted verb: `payment.verified`, `booking.cancelled`, `driver.assigned`. */
    action: varchar('action', { length: 80 }).notNull(),
    entity: varchar('entity', { length: 40 }).notNull(),
    entityId: int('entity_id').notNull(),
    data: json('data'),
    createdAt: datetime('created_at', { mode: 'date' }).notNull(),
  },
  (t) => [
    index('audit_log_entity_idx').on(t.entity, t.entityId),
    index('audit_log_actor_idx').on(t.actorType, t.actorId),
    index('audit_log_created_idx').on(t.createdAt),
  ],
);
```

- [ ] **Step 4: Implement `writeAudit`**

```ts
// server/src/services/audit.ts
import { AUDIT_ACTOR_TYPES, auditLog } from '../db/schema';
import type { Transaction } from '../db/client';

export type AuditActorType = (typeof AUDIT_ACTOR_TYPES)[number];

export interface AuditEntry {
  actorType: AuditActorType;
  actorId: number | null;
  action: string;
  entity: string;
  entityId: number;
  data?: unknown;
}

/**
 * The ONE way an audit row is created.
 *
 * Takes a transaction handle, never the pool: an audit row written outside
 * the transaction it describes survives a rollback, and then the log claims
 * a payment was verified when it was not. Every caller is already inside a
 * transaction for the change itself — pass that handle through.
 *
 * Never put a secret, a password hash, a gateway key or a full card/e-wallet
 * payload in `data`. It is read by admins in the UI and exported in reports.
 */
export async function writeAudit(tx: Transaction, entry: AuditEntry): Promise<void> {
  await tx.insert(auditLog).values({
    actorType: entry.actorType,
    actorId: entry.actorId,
    action: entry.action,
    entity: entry.entity,
    entityId: entry.entityId,
    data: entry.data ?? null,
    createdAt: new Date(),
  });
}
```

`Transaction` is exported from `server/src/db/client.ts` as `type Transaction = Parameters<Parameters<ReturnType<typeof getDb>['transaction']>[0]>[0]` — add it there if it does not exist yet.

- [ ] **Step 5: Prove both tests fail, restore, run the five checks, commit**

```bash
git commit -m "feat(db): audit_log, written only inside the transaction it describes"
```

**✅ DONE 2**

---

### Task 3: `vans`

**Files:**

- Modify: `server/src/db/schema.ts`
- Test: `server/src/__tests__/schema-fleet.test.ts`

**Interfaces:**

- Produces: `vans` table; `VAN_STATUSES = ['available','on_trip','for_repair'] as const`.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { getDb } from '../db/client';

describe('vans', () => {
  it('stores capacity as a plain integer seat count', async () => {
    const [cols] = await getDb().execute(sql`
      SELECT COLUMN_NAME, DATA_TYPE FROM information_schema.columns
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'vans' AND COLUMN_NAME = 'capacity'`);
    expect(cols[0]?.DATA_TYPE).toBe('int');
  });

  it('refuses two vans with the same plate', async () => {
    const db = getDb();
    const plate = `TEST-${Date.now()}`;
    await db.execute(sql`INSERT INTO vans (plate, model, capacity, status, is_active, created_at, updated_at)
      VALUES (${plate}, 'Hiace', 12, 'available', 1, UTC_TIMESTAMP(), UTC_TIMESTAMP())`);
    await expect(
      db.execute(sql`INSERT INTO vans (plate, model, capacity, status, is_active, created_at, updated_at)
        VALUES (${plate}, 'Starex', 10, 'available', 1, UTC_TIMESTAMP(), UTC_TIMESTAMP())`),
    ).rejects.toThrow(/duplicate/i);
  });
});
```

- [ ] **Step 2: Run it and watch it fail** — Expected: FAIL, table `vans` doesn't exist.

- [ ] **Step 3: Add the table**

```ts
export const VAN_STATUSES = ['available', 'on_trip', 'for_repair'] as const;

export const vans = mysqlTable(
  'vans',
  {
    id: int('id').autoincrement().primaryKey(),
    plate: varchar('plate', { length: 20 }).notNull().unique(),
    model: varchar('model', { length: 120 }).notNull(),
    /** Seats available to guests, not including the driver. Feeds the §5 capacity check. */
    capacity: int('capacity').notNull(),
    status: mysqlEnum('status', VAN_STATUSES).notNull().default('available'),
    odometer: int('odometer'),
    lastService: date('last_service'),
    nextService: date('next_service'),
    orcrExpiry: date('orcr_expiry'),
    franchiseNo: varchar('franchise_no', { length: 80 }),
    franchiseExpiry: date('franchise_expiry'),
    repairNotes: text('repair_notes'),
    isActive: boolean('is_active').notNull().default(true),
    createdAt: datetime('created_at', { mode: 'date' }).notNull(),
    updatedAt: datetime('updated_at', { mode: 'date' }).notNull(),
  },
  (t) => [index('vans_active_status_idx').on(t.isActive, t.status, t.capacity)],
);
```

The index is ordered for the §5 capacity query, which filters active + not-for-repair and then needs `capacity >= pax`.

- [ ] **Step 4: Run the test, five checks, commit**

```bash
git commit -m "feat(db): vans"
```

**✅ DONE 3**

---

### Task 4: `drivers` and `driver_leaves`

**Files:**

- Modify: `server/src/db/schema.ts`
- Test: `server/src/__tests__/schema-fleet.test.ts` (extend)

**Interfaces:**

- Consumes: nothing. `driver_leaves` → `drivers` is a Wave 2 FK but both tables are defined here; the migration generator places them correctly because `driver_leaves` references `drivers.id`.
- Produces: `drivers`, `driverLeaves` tables; `DRIVER_STATUSES = ['available','on_trip','off_duty'] as const`.

- [ ] **Step 1: Write the failing test**

```ts
describe('drivers', () => {
  it('never stores a PIN in plain text — only a hash column exists', async () => {
    const [cols] = await getDb().execute(sql`
      SELECT COLUMN_NAME FROM information_schema.columns
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'drivers'`);
    const names = cols.map((c) => String(c.COLUMN_NAME));
    expect(names).toContain('pin_hash');
    expect(names).not.toContain('pin');
    expect(names.filter((n) => /^pin/.test(n))).toEqual(['pin_hash']);
  });

  it('refuses two drivers with the same code', async () => {
    const db = getDb();
    const code = `D${Date.now() % 100000}`;
    await db.execute(sql`INSERT INTO drivers (name, code, phone, pin_hash, status, is_active, created_at, updated_at)
      VALUES ('Test One', ${code}, '09170000000', 'x', 'available', 1, UTC_TIMESTAMP(), UTC_TIMESTAMP())`);
    await expect(
      db.execute(sql`INSERT INTO drivers (name, code, phone, pin_hash, status, is_active, created_at, updated_at)
        VALUES ('Test Two', ${code}, '09170000001', 'y', 'available', 1, UTC_TIMESTAMP(), UTC_TIMESTAMP())`),
    ).rejects.toThrow(/duplicate/i);
  });
});
```

- [ ] **Step 2: Run it and watch it fail.**

- [ ] **Step 3: Add both tables**

```ts
export const DRIVER_STATUSES = ['available', 'on_trip', 'off_duty'] as const;

export const drivers = mysqlTable(
  'drivers',
  {
    id: int('id').autoincrement().primaryKey(),
    name: varchar('name', { length: 160 }).notNull(),
    /** Short login code the driver types on the portal, e.g. "D07". */
    code: varchar('code', { length: 20 }).notNull().unique(),
    phone: varchar('phone', { length: 40 }).notNull(),
    /** argon2id/bcrypt of the PIN. The PIN itself is never stored or logged. */
    pinHash: varchar('pin_hash', { length: 255 }).notNull(),
    failedAttempts: int('failed_attempts').notNull().default(0),
    lockedUntil: datetime('locked_until', { mode: 'date' }),
    licenseNo: varchar('license_no', { length: 80 }),
    licenseExpiry: date('license_expiry'),
    languages: json('languages'),
    emergencyContact: varchar('emergency_contact', { length: 200 }),
    status: mysqlEnum('status', DRIVER_STATUSES).notNull().default('available'),
    isActive: boolean('is_active').notNull().default(true),
    createdAt: datetime('created_at', { mode: 'date' }).notNull(),
    updatedAt: datetime('updated_at', { mode: 'date' }).notNull(),
  },
  (t) => [index('drivers_active_status_idx').on(t.isActive, t.status)],
);

export const driverLeaves = mysqlTable(
  'driver_leaves',
  {
    id: int('id').autoincrement().primaryKey(),
    driverId: int('driver_id')
      .notNull()
      .references(() => drivers.id),
    /** Civil dates in Asia/Manila, inclusive both ends. */
    startDate: date('start_date').notNull(),
    endDate: date('end_date').notNull(),
    reason: varchar('reason', { length: 300 }),
    createdAt: datetime('created_at', { mode: 'date' }).notNull(),
  },
  (t) => [index('driver_leaves_driver_range_idx').on(t.driverId, t.startDate, t.endDate)],
);
```

- [ ] **Step 4: Run the test, five checks, commit**

```bash
git commit -m "feat(db): drivers and driver_leaves"
```

**✅ DONE 4**

---

### Task 5: `coupons`

**Files:**

- Modify: `server/src/db/schema.ts`
- Create: `shared/src/coupon.ts`
- Test: `server/src/__tests__/schema-coupons.test.ts`

**Interfaces:**

- Produces: `coupons` table; from `@rg/shared`: `DISCOUNT_TYPES = ['percent','fixed'] as const`,
  `type DiscountType`, `couponDiscountSchema`.

**Owner decision, 2026-10-11 (answers Q6).** The spec's single `value` column — one `int` meaning
percent points or centavos depending on a sibling column — is replaced by three columns and a
database CHECK:

| Column            | Type                      | Meaning                                                      |
| ----------------- | ------------------------- | ------------------------------------------------------------ |
| `discount_type`   | `enum('percent','fixed')` | Which of the two below is in use                             |
| `percent_bp`      | `int NULL`                | **Basis points.** `1000` = 10%, `250` = 2.5%, `10000` = 100% |
| `amount_centavos` | `int NULL`                | Flat discount in centavos                                    |

Exactly one of `percent_bp` / `amount_centavos` is set, and it must match `discount_type`. That is
enforced by a `CHECK`, not only by Zod — verified available: this project runs **MySQL 8.0.46**,
which has enforced `CHECK` since 8.0.16, and **drizzle-orm 0.44.7** exports `check()` from
`mysql-core`. (On MySQL 8.0.15 or earlier the constraint would be _parsed and silently ignored_, so
the test below is what proves it is actually live rather than decorative.)

Basis points, not whole percent, because 2.5% off is a thing a marketing campaign asks for and an
`int` percent cannot express it without the schema changing again.

- [ ] **Step 1: Write the failing test**

```ts
describe('coupons', () => {
  it('stores the discount as basis points or centavos, never a float', async () => {
    const [cols] = await getDb().execute(sql`
      SELECT COLUMN_NAME, DATA_TYPE, IS_NULLABLE FROM information_schema.columns
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'coupons'
        AND COLUMN_NAME IN ('discount_type','percent_bp','amount_centavos')
      ORDER BY COLUMN_NAME`);
    expect(cols.map((c) => String(c.COLUMN_NAME))).toEqual([
      'amount_centavos',
      'discount_type',
      'percent_bp',
    ]);
    expect(cols.find((c) => c.COLUMN_NAME === 'percent_bp')?.DATA_TYPE).toBe('int');
    expect(cols.find((c) => c.COLUMN_NAME === 'amount_centavos')?.DATA_TYPE).toBe('int');
    // Both nullable: exactly one is set per row, and the CHECK decides which.
    expect(cols.every((c) => c.IS_NULLABLE === 'YES' || c.COLUMN_NAME === 'discount_type')).toBe(
      true,
    );
  });

  it('accepts a well-formed percent coupon', async () => {
    await expect(
      insertCoupon({ discountType: 'percent', percentBp: 1000, amountCentavos: null }),
    ).resolves.toBeDefined();
  });

  it('accepts a well-formed fixed coupon', async () => {
    await expect(
      insertCoupon({ discountType: 'fixed', percentBp: null, amountCentavos: 10000 }),
    ).resolves.toBeDefined();
  });

  // The four ways a row can be malformed. Each must be refused BY THE DATABASE,
  // so a bad row cannot arrive through a path that skipped Zod — a seed script,
  // a migration, a manual fix in a SQL client at 2am.
  it('REFUSES percent with the centavos column set instead', async () => {
    await expect(
      insertCoupon({ discountType: 'percent', percentBp: null, amountCentavos: 10000 }),
    ).rejects.toThrow(/check constraint/i);
  });

  it('REFUSES fixed with the basis-points column set instead', async () => {
    await expect(
      insertCoupon({ discountType: 'fixed', percentBp: 1000, amountCentavos: null }),
    ).rejects.toThrow(/check constraint/i);
  });

  it('REFUSES both columns set at once', async () => {
    await expect(
      insertCoupon({ discountType: 'percent', percentBp: 1000, amountCentavos: 10000 }),
    ).rejects.toThrow(/check constraint/i);
  });

  it('REFUSES neither column set', async () => {
    await expect(
      insertCoupon({ discountType: 'percent', percentBp: null, amountCentavos: null }),
    ).rejects.toThrow(/check constraint/i);
  });

  it('refuses a duplicate code', async () => {
    const code = `SAVE${Date.now() % 100000}`;
    await insertCoupon({ code, discountType: 'percent', percentBp: 1000, amountCentavos: null });
    await expect(
      insertCoupon({ code, discountType: 'fixed', percentBp: null, amountCentavos: 10000 }),
    ).rejects.toThrow(/duplicate/i);
  });
});
```

`insertCoupon` is a local helper in the test file that issues a raw `INSERT` — **not** a Drizzle
insert through a Zod-validated service. The whole point of these four rejection tests is that the
_database_ refuses the row, so they must bypass every application-level check. A version of this
test that goes through a validating helper proves nothing about the CHECK and would stay green if
the constraint were dropped.

- [ ] **Step 2: Run it and watch it fail**

Run: `pnpm --filter @rg/server test schema-coupons`
Expected: FAIL — table `coupons` does not exist.

- [ ] **Step 3: Add the shared discount types**

```ts
// shared/src/coupon.ts
import { z } from 'zod';

export const DISCOUNT_TYPES = ['percent', 'fixed'] as const;
export type DiscountType = (typeof DISCOUNT_TYPES)[number];

/**
 * A coupon's discount, as a discriminated union — so TypeScript makes the
 * invalid combinations unrepresentable in code, the same way the CHECK
 * constraint makes them unrepresentable in the database.
 *
 * `percentBp` is BASIS POINTS: 1000 = 10%, 250 = 2.5%. Whole-percent ints
 * cannot express 2.5% without another schema change, and a float has no
 * business anywhere near money.
 */
export const couponDiscountSchema = z.discriminatedUnion('discountType', [
  z.object({
    discountType: z.literal('percent'),
    percentBp: z.number().int().min(1).max(10000),
    amountCentavos: z.null(),
  }),
  z.object({
    discountType: z.literal('fixed'),
    percentBp: z.null(),
    amountCentavos: z.number().int().positive(),
  }),
]);
export type CouponDiscount = z.infer<typeof couponDiscountSchema>;
```

- [ ] **Step 4: Add the table with the CHECK**

```ts
import { check } from 'drizzle-orm/mysql-core';
import { sql } from 'drizzle-orm';

export const coupons = mysqlTable(
  'coupons',
  {
    id: int('id').autoincrement().primaryKey(),
    code: varchar('code', { length: 40 }).notNull().unique(),

    discountType: mysqlEnum('discount_type', DISCOUNT_TYPES).notNull(),
    /** Basis points: 1000 = 10%, 250 = 2.5%. Set iff discount_type='percent'. */
    percentBp: int('percent_bp'),
    /** Flat discount in centavos. Set iff discount_type='fixed'. */
    amountCentavos: int('amount_centavos'),

    minSpendCentavos: int('min_spend_centavos'),
    startsAt: datetime('starts_at', { mode: 'date' }),
    endsAt: datetime('ends_at', { mode: 'date' }),
    usageLimit: int('usage_limit'),
    usedCount: int('used_count').notNull().default(0),
    isActive: boolean('is_active').notNull().default(true),
    createdAt: datetime('created_at', { mode: 'date' }).notNull(),
    updatedAt: datetime('updated_at', { mode: 'date' }).notNull(),
  },
  (t) => [
    index('coupons_active_window_idx').on(t.isActive, t.startsAt, t.endsAt),
    /**
     * Exactly one discount column is set, and it matches discount_type.
     *
     * In the database, not only in Zod: a seed script, a migration or a
     * hand-written UPDATE all bypass application validation, and a coupon
     * row with neither column set would make every discount silently zero
     * while looking perfectly valid in the admin list.
     */
    check(
      'coupons_discount_shape',
      sql`(${t.discountType} = 'percent' AND ${t.percentBp} IS NOT NULL AND ${t.amountCentavos} IS NULL)
       OR (${t.discountType} = 'fixed'   AND ${t.amountCentavos} IS NOT NULL AND ${t.percentBp} IS NULL)`,
    ),
  ],
);
```

- [ ] **Step 5: Confirm the CHECK is live, not merely written**

Before trusting it, read the generated migration SQL and confirm the `CONSTRAINT … CHECK (…)` is in
the `CREATE TABLE`, then after migrating:

```sql
SELECT CONSTRAINT_NAME, CHECK_CLAUSE FROM information_schema.check_constraints
WHERE CONSTRAINT_SCHEMA = DATABASE() AND CONSTRAINT_NAME = 'coupons_discount_shape';
```

One row means MySQL accepted and will enforce it. Zero rows means it was dropped silently — stop and
report rather than relying on Zod alone.

- [ ] **Step 6: Prove the rejection tests can fail**

Drop the constraint (`ALTER TABLE coupons DROP CHECK coupons_discount_shape;`), re-run — the four
rejection tests must all go red — then restore it by re-running the migration. State what the red
looked like.

- [ ] **Step 7: Run the five checks and commit**

```bash
git commit -m "feat(db): coupons, with a CHECK that the discount shape is valid"
```

**✅ DONE 5**

---

### Task 6: `tour_date_slots` and `payment_events`, then generate Wave 1

**Files:**

- Modify: `server/src/db/schema.ts`
- Create: `server/src/db/migrations/0002_*.sql` (generated)
- Test: `server/src/__tests__/schema-locks.test.ts`

**Interfaces:**

- Consumes: `tours` (existing).
- Produces: `tourDateSlots`, `paymentEvents` tables; `PAYMENT_PROVIDERS = ['paymongo','xendit','manual'] as const`.

`tour_date_slots` exists only to be locked. §5: "run the check and the booking insert in one DB
transaction with a row lock on a `tour_date_slots` row (`SELECT … FOR UPDATE`)". The row is created
on demand with `INSERT … ON DUPLICATE KEY UPDATE tour_id = tour_id` (a no-op touch that is safe to
race), then selected `FOR UPDATE`.

> **⚠ BLOCKED ON Q14 — read before building this table.**
>
> The owner's Q7 answer (2026-10-11) makes the fleet a resource shared **across all tours**:
> accept up to `MIN(tour.groups_per_day, vans free that day across all tours)`. A per-tour lock
> cannot enforce a cross-tour limit — two bookings for **different** tours on the same date lock
> **different** `tour_date_slots` rows, so neither waits for the other and both can claim the last
> van.
>
> The recommended fix is a 17th table, `fleet_date_slots (date)`, locked `FOR UPDATE` **before**
> the per-tour row, always in that order so the pair cannot deadlock. That is one extra table
> beyond this plan's scope, so it is **not built until Q14 is answered**. Build `tour_date_slots`
> as specified here; leave the fleet lock alone.
>
> If Q14 comes back as option A, add to this task:
>
> ```ts
> export const fleetDateSlots = mysqlTable('fleet_date_slots', {
>   /** Civil date in Asia/Manila. One row per bookable day, created on demand. */
>   date: date('date').primaryKey(),
> });
> ```
>
> …and a test asserting two concurrent bookings for _different_ tours on the same date serialise.
> That test belongs with the Week 3 capacity service, which is where the lock is actually taken.

- [ ] **Step 1: Write the failing test**

```ts
describe('tour_date_slots', () => {
  it('has a composite primary key on (tour_id, date), so one row per tour-day', async () => {
    const [cols] = await getDb().execute(sql`
      SELECT COLUMN_NAME FROM information_schema.key_column_usage
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'tour_date_slots'
        AND CONSTRAINT_NAME = 'PRIMARY' ORDER BY ORDINAL_POSITION`);
    expect(cols.map((c) => String(c.COLUMN_NAME))).toEqual(['tour_id', 'date']);
  });
});

describe('payment_events', () => {
  it('is unique on (provider, provider_event_id), not on the event id alone', async () => {
    const db = getDb();
    await db.execute(sql`INSERT INTO payment_events (provider, provider_event_id, type, received_at)
      VALUES ('paymongo', 'evt_shared', 'payment.paid', UTC_TIMESTAMP())`);
    // Same id, different provider: allowed. Two gateways can mint the same string.
    await expect(
      db.execute(sql`INSERT INTO payment_events (provider, provider_event_id, type, received_at)
        VALUES ('xendit', 'evt_shared', 'payment.paid', UTC_TIMESTAMP())`),
    ).resolves.toBeDefined();
    // Same id, same provider: refused. This is the idempotency guarantee.
    await expect(
      db.execute(sql`INSERT INTO payment_events (provider, provider_event_id, type, received_at)
        VALUES ('paymongo', 'evt_shared', 'payment.paid', UTC_TIMESTAMP())`),
    ).rejects.toThrow(/duplicate/i);
  });
});
```

Both halves matter. Prove the second can fail by making the unique index cover `provider_event_id` alone — the cross-provider insert then goes red, which is the bug that index shape prevents.

- [ ] **Step 2: Run it and watch it fail.**

- [ ] **Step 3: Add both tables**

```ts
export const tourDateSlots = mysqlTable(
  'tour_date_slots',
  {
    tourId: int('tour_id')
      .notNull()
      .references(() => tours.id),
    /** Civil date in Asia/Manila — the tour day, not an instant. */
    date: date('date').notNull(),
  },
  (t) => [primaryKey({ columns: [t.tourId, t.date] })],
);

export const PAYMENT_PROVIDERS = ['paymongo', 'xendit', 'manual'] as const;

export const paymentEvents = mysqlTable(
  'payment_events',
  {
    id: int('id').autoincrement().primaryKey(),
    provider: mysqlEnum('provider', PAYMENT_PROVIDERS).notNull(),
    /** The gateway's own event id. Unique PER PROVIDER, never globally. */
    providerEventId: varchar('provider_event_id', { length: 191 }).notNull(),
    type: varchar('type', { length: 80 }).notNull(),
    payload: json('payload'),
    receivedAt: datetime('received_at', { mode: 'date' }).notNull(),
    /** Null until the event has been acted on; lets a crash mid-processing be retried. */
    processedAt: datetime('processed_at', { mode: 'date' }),
  },
  (t) => [
    uniqueIndex('payment_events_provider_event_unique').on(t.provider, t.providerEventId),
    index('payment_events_unprocessed_idx').on(t.processedAt),
  ],
);
```

191 characters, not 255: this column sits in a unique index, and `utf8mb4` at 4 bytes/char puts 255 over MySQL's 767-byte index prefix limit on older row formats. 191 is the conventional safe maximum.

- [ ] **Step 4: Generate and apply Wave 1**

```bash
pnpm --filter @rg/server db:generate
pnpm --filter @rg/server db:migrate
```

Read the generated SQL before applying it. It must contain `CREATE TABLE` for `users`, `vans`, `drivers`, `driver_leaves`, `coupons`, `audit_log`, `tour_date_slots`, `payment_events` and nothing else destructive. If drizzle-kit proposes dropping or altering an existing table, STOP — that is a schema drift bug, not an expected migration.

- [ ] **Step 5: Run the five checks and commit**

```bash
git add server/src/db/schema.ts server/src/db/migrations/ server/src/__tests__/
git commit -m "feat(db): wave 1 — fleet, users, coupons, audit, lock and event tables"
```

**✅ DONE 6**

---

## Phase 2 — Booking core (Waves 2–3)

### Task 7: `sessions`

**Files:**

- Modify: `server/src/db/schema.ts`
- Test: `server/src/__tests__/schema-sessions.test.ts`

**Interfaces:**

- Consumes: `users`, `drivers`.
- Produces: `sessions` table; `SESSION_SUBJECTS = ['user','customer','driver'] as const`.

**`subject_id` is polymorphic and carries no FK** — `user` → `users.id`, `driver` → `drivers.id`, `customer` → `bookings.id` (a customer session is scoped to exactly one booking, per §7: "Creates a session scoped to that booking only"). See Open Question Q1: the spec says `subject_id` without saying what a customer's subject is, and this plan reads it as the booking id because that is what the scoping rule requires.

- [ ] **Step 1: Write the failing test**

```ts
describe('sessions', () => {
  it('stores an opaque token hash, never the raw token', async () => {
    const [cols] = await getDb().execute(sql`
      SELECT COLUMN_NAME FROM information_schema.columns
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'sessions'`);
    const names = cols.map((c) => String(c.COLUMN_NAME));
    expect(names).toContain('token_hash');
    expect(names).not.toContain('token');
  });

  it('expires: a row carries an explicit UTC expiry', async () => {
    const [cols] = await getDb().execute(sql`
      SELECT DATA_TYPE, IS_NULLABLE FROM information_schema.columns
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'sessions' AND COLUMN_NAME = 'expires_at'`);
    expect(cols[0]?.DATA_TYPE).toBe('datetime');
    expect(cols[0]?.IS_NULLABLE).toBe('NO');
  });
});
```

- [ ] **Step 2: Run it and watch it fail.**

- [ ] **Step 3: Add the table**

```ts
export const SESSION_SUBJECTS = ['user', 'customer', 'driver'] as const;

export const sessions = mysqlTable(
  'sessions',
  {
    id: int('id').autoincrement().primaryKey(),
    /** Which table `subject_id` points at. No FK — see "Polymorphic columns". */
    subjectType: mysqlEnum('subject_type', SESSION_SUBJECTS).notNull(),
    /** users.id | drivers.id | bookings.id, per subject_type. */
    subjectId: int('subject_id').notNull(),
    /**
     * SHA-256 of the session token. The raw token exists only in the cookie.
     * A stolen database therefore yields no usable sessions.
     */
    tokenHash: varchar('token_hash', { length: 64 }).notNull().unique(),
    expiresAt: datetime('expires_at', { mode: 'date' }).notNull(),
    createdAt: datetime('created_at', { mode: 'date' }).notNull(),
  },
  (t) => [
    index('sessions_subject_idx').on(t.subjectType, t.subjectId),
    index('sessions_expiry_idx').on(t.expiresAt),
  ],
);
```

- [ ] **Step 4: Run the test, five checks, commit**

```bash
git commit -m "feat(db): sessions, storing a token hash and never the token"
```

**✅ DONE 7**

---

### Task 8: `bookings`

**Files:**

- Modify: `server/src/db/schema.ts`
- Create: `shared/src/booking.ts`
- Test: `server/src/__tests__/schema-bookings.test.ts`

**Interfaces:**

- Consumes: `tours` (existing), `vans`, `drivers`, `coupons`.
- Produces: `bookings` table; from `@rg/shared`: `BOOKING_STATUSES`, `type BookingStatus`, `PAY_MODES = ['full','deposit'] as const`, `CAPACITY_HOLDING_STATUSES`.

- [ ] **Step 1: Write the failing test**

```ts
import { BOOKING_STATUSES, CAPACITY_HOLDING_STATUSES } from '@rg/shared';

describe('booking statuses', () => {
  it('matches BUILD_SPEC section 5 exactly, in order', () => {
    expect([...BOOKING_STATUSES]).toEqual([
      'pending_payment',
      'pending_verification',
      'confirmed',
      'assigned',
      'in_progress',
      'completed',
      'cancelled',
      'expired',
    ]);
  });

  it('holds capacity for exactly the five statuses the spec marks "Yes"', () => {
    expect([...CAPACITY_HOLDING_STATUSES]).toEqual([
      'pending_payment',
      'pending_verification',
      'confirmed',
      'assigned',
      'in_progress',
    ]);
    for (const done of ['completed', 'cancelled', 'expired'] as const) {
      expect(CAPACITY_HOLDING_STATUSES).not.toContain(done);
    }
  });
});

describe('bookings', () => {
  it('stores every money column as int centavos, never decimal', async () => {
    const [cols] = await getDb().execute(sql`
      SELECT COLUMN_NAME, DATA_TYPE FROM information_schema.columns
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'bookings'
        AND COLUMN_NAME LIKE '%centavos'`);
    expect(cols.length).toBeGreaterThanOrEqual(4);
    for (const c of cols) expect(c.DATA_TYPE).toBe('int');
  });

  it('refuses a duplicate public ref', async () => {
    // ... insert two bookings with the same ref; second rejects /duplicate/i
  });
});
```

The capacity test is the load-bearing one: get that set wrong and the system oversells or refuses valid bookings. Prove it fails by adding `'completed'` to the constant.

- [ ] **Step 2: Run it and watch it fail.**

- [ ] **Step 3: Add the shared constants**

```ts
// shared/src/booking.ts
import { z } from 'zod';

/** BUILD_SPEC §5 "Booking statuses", in the spec's own order. */
export const BOOKING_STATUSES = [
  'pending_payment',
  'pending_verification',
  'confirmed',
  'assigned',
  'in_progress',
  'completed',
  'cancelled',
  'expired',
] as const;
export type BookingStatus = (typeof BOOKING_STATUSES)[number];

/**
 * The statuses the spec's table marks "Holds capacity: Yes".
 *
 * Derived from that table and nowhere else. The §5 capacity check counts
 * bookings in these statuses against `groups_per_day`, and against van and
 * driver availability. Adding a status here oversells nothing but refuses
 * valid bookings; REMOVING one oversells the fleet, which is the expensive
 * direction.
 */
export const CAPACITY_HOLDING_STATUSES = [
  'pending_payment',
  'pending_verification',
  'confirmed',
  'assigned',
  'in_progress',
] as const;

export const PAY_MODES = ['full', 'deposit'] as const;
export type PayMode = (typeof PAY_MODES)[number];

/** `RG-` plus six unambiguous characters. See server/src/services/booking-ref.ts. */
export const bookingRefSchema = z
  .string()
  .regex(/^RG-[ABCDEFGHJKMNPQRSTVWXYZ23456789]{6}$/, 'Not a valid booking reference');
```

- [ ] **Step 4: Add the table**

```ts
export const bookings = mysqlTable(
  'bookings',
  {
    id: int('id').autoincrement().primaryKey(),
    /** Public, random, non-sequential: RG-7KQ4M9. Never expose `id` to a guest. */
    ref: varchar('ref', { length: 12 }).notNull().unique(),
    tourId: int('tour_id')
      .notNull()
      .references(() => tours.id),
    /** Civil date in Asia/Manila. */
    tourDate: date('tour_date').notNull(),
    pax: int('pax').notNull(),

    leadName: varchar('lead_name', { length: 160 }).notNull(),
    leadEmail: varchar('lead_email', { length: 200 }).notNull(),
    leadPhone: varchar('lead_phone', { length: 40 }).notNull(),
    pickup: varchar('pickup', { length: 400 }),
    pickupMapUrl: varchar('pickup_map_url', { length: 500 }),
    requests: text('requests'),

    status: mysqlEnum('status', BOOKING_STATUSES).notNull().default('pending_payment'),
    payMode: mysqlEnum('pay_mode', PAY_MODES).notNull(),

    /**
     * Frozen copy of the tier price, add-on prices, coupon and totals at the
     * moment of booking (§5: "Later price edits don't change existing
     * bookings"). Read-only after insert; the columns below are the
     * queryable summary of it, not a second source of truth.
     */
    priceSnapshot: json('price_snapshot').notNull(),
    subtotalCentavos: int('subtotal_centavos').notNull(),
    discountCentavos: int('discount_centavos').notNull().default(0),
    totalCentavos: int('total_centavos').notNull(),
    amountPaidCentavos: int('amount_paid_centavos').notNull().default(0),

    couponId: int('coupon_id').references(() => coupons.id),
    vanId: int('van_id').references(() => vans.id),
    driverId: int('driver_id').references(() => drivers.id),

    /** 15-minute hold (§5). Null once the booking is paid or finished. */
    holdExpiresAt: datetime('hold_expires_at', { mode: 'date' }),
    startedAt: datetime('started_at', { mode: 'date' }),
    completedAt: datetime('completed_at', { mode: 'date' }),
    cancelledAt: datetime('cancelled_at', { mode: 'date' }),
    cancelReason: varchar('cancel_reason', { length: 400 }),

    createdAt: datetime('created_at', { mode: 'date' }).notNull(),
    updatedAt: datetime('updated_at', { mode: 'date' }).notNull(),
  },
  (t) => [
    // The three indexes BUILD_SPEC §10 names, verbatim.
    index('bookings_tour_date_status_idx').on(t.tourId, t.tourDate, t.status),
    index('bookings_ref_idx').on(t.ref),
    index('bookings_driver_date_idx').on(t.driverId, t.tourDate),
    // Added: the cron that expires holds scans this every minute.
    index('bookings_hold_expiry_idx').on(t.status, t.holdExpiresAt),
  ],
);
```

`balance` is deliberately **not** a column: §5 defines it as `total - amount_paid`, and storing a derived value invites the two to disagree. Compute it at read time.

- [ ] **Step 5: Run the tests, five checks, commit**

```bash
git commit -m "feat(db): bookings, with the price snapshot and the spec's three indexes"
```

**✅ DONE 8**

---

### Task 9: `generateBookingRef()` and collision-safe insert

**Files:**

- Create: `server/src/services/booking-ref.ts`
- Test: `server/src/__tests__/booking-ref.test.ts`

**Interfaces:**

- Consumes: `bookings` (Task 8), `bookingRefSchema` (Task 8).
- Produces: `generateBookingRef(): string`, `insertBookingWithRef(tx, values): Promise<{ id: number; ref: string }>`.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it, vi } from 'vitest';
import { bookingRefSchema } from '@rg/shared';
import { generateBookingRef, REF_ALPHABET } from '../services/booking-ref';

describe('generateBookingRef', () => {
  it('matches the public ref format', () => {
    for (let i = 0; i < 200; i += 1) {
      expect(bookingRefSchema.safeParse(generateBookingRef()).success).toBe(true);
    }
  });

  it('omits characters a guest could misread over the phone', () => {
    // 0/O, 1/I/L, U (reads as V in some hands) are all excluded.
    for (const banned of ['0', 'O', '1', 'I', 'L', 'U']) {
      expect(REF_ALPHABET).not.toContain(banned);
    }
  });

  it('is not sequential — 500 refs share no common prefix beyond "RG-"', () => {
    const refs = Array.from({ length: 500 }, generateBookingRef);
    const firstChars = new Set(refs.map((r) => r[3]));
    expect(firstChars.size).toBeGreaterThan(5);
  });

  it('draws from crypto randomness, not Math.random', () => {
    const spy = vi.spyOn(Math, 'random');
    generateBookingRef();
    expect(spy, 'booking refs must not come from Math.random').not.toHaveBeenCalled();
    spy.mockRestore();
  });
});
```

The `Math.random` test is the one that would otherwise be vacuous — prove it fails by implementing the generator with `Math.random()` and watching it go red.

- [ ] **Step 2: Run it and watch it fail.**

- [ ] **Step 3: Implement**

```ts
// server/src/services/booking-ref.ts
import { randomInt } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { bookings } from '../db/schema';
import type { Transaction } from '../db/client';

/**
 * 32 characters, chosen so a ref can be read aloud over a bad phone line:
 * no 0/O, no 1/I/L, no U. Matches `bookingRefSchema` in @rg/shared — change
 * one and the other rejects every ref you mint.
 */
export const REF_ALPHABET = 'ABCDEFGHJKMNPQRSTVWXYZ23456789';

/**
 * `RG-` + 6 characters from REF_ALPHABET = 30^6 ≈ 729 million refs.
 *
 * `randomInt` (CSPRNG), never `Math.random`: a guessable ref is a customer
 * portal login factor (§7 logs in with ref + email), so predictable refs
 * would let someone enumerate other people's bookings.
 */
export function generateBookingRef(): string {
  let out = '';
  for (let i = 0; i < 6; i += 1) out += REF_ALPHABET[randomInt(REF_ALPHABET.length)];
  return `RG-${out}`;
}

/**
 * Inserts a booking, retrying on the 1-in-729-million ref collision.
 *
 * Retries on the UNIQUE violation rather than SELECTing first: a check-then-
 * insert races another request between the two statements, and the database
 * is the only thing that can decide uniqueness atomically.
 */
export async function insertBookingWithRef(
  tx: Transaction,
  values: Omit<typeof bookings.$inferInsert, 'ref'>,
): Promise<{ id: number; ref: string }> {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const ref = generateBookingRef();
    try {
      await tx.insert(bookings).values({ ...values, ref });
      const [row] = await tx
        .select({ id: bookings.id })
        .from(bookings)
        .where(eq(bookings.ref, ref));
      return { id: row!.id, ref };
    } catch (error) {
      if ((error as { code?: string }).code !== 'ER_DUP_ENTRY') throw error;
    }
  }
  throw new Error('Could not allocate a unique booking reference after 5 attempts.');
}
```

- [ ] **Step 4: Run the tests, five checks, commit**

```bash
git commit -m "feat(booking): crypto-random public refs with collision retry"
```

**✅ DONE 9**

---

### Task 10: `booking_addons`, `booking_notes`, `coupon_redemptions`

**Files:**

- Modify: `server/src/db/schema.ts`
- Test: `server/src/__tests__/schema-booking-lines.test.ts`

**Interfaces:**

- Consumes: `bookings`, `tour_addons` (existing), `users`, `coupons`.
- Produces: `bookingAddons`, `bookingNotes`, `couponRedemptions` tables.

- [ ] **Step 1: Write the failing test**

```ts
describe('booking_addons', () => {
  it('snapshots the add-on name and price, so a later edit cannot rewrite history', async () => {
    const [cols] = await getDb().execute(sql`
      SELECT COLUMN_NAME FROM information_schema.columns
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'booking_addons'`);
    const names = cols.map((c) => String(c.COLUMN_NAME));
    // The FK alone is not enough: the row must carry its own copy.
    expect(names).toContain('addon_id');
    expect(names).toContain('name');
    expect(names).toContain('price_centavos');
    expect(names).toContain('per_person');
    expect(names).toContain('qty');
  });
});

describe('coupon_redemptions', () => {
  it('records at most one redemption per coupon per booking', async () => {
    // insert (coupon 1, booking 1) twice; second rejects /duplicate/i
  });
});
```

- [ ] **Step 2: Run it and watch it fail.**

- [ ] **Step 3: Add the three tables**

```ts
export const bookingAddons = mysqlTable(
  'booking_addons',
  {
    id: int('id').autoincrement().primaryKey(),
    bookingId: int('booking_id')
      .notNull()
      .references(() => bookings.id),
    /** Which add-on this was. Kept for reporting; the row does not trust it for money. */
    addonId: int('addon_id')
      .notNull()
      .references(() => tourAddons.id),
    /** Snapshot: the add-on may be renamed or repriced later (§5 price snapshot). */
    name: varchar('name', { length: 200 }).notNull(),
    priceCentavos: int('price_centavos').notNull(),
    perPerson: boolean('per_person').notNull(),
    qty: int('qty').notNull().default(1),
  },
  (t) => [index('booking_addons_booking_idx').on(t.bookingId)],
);

export const bookingNotes = mysqlTable(
  'booking_notes',
  {
    id: int('id').autoincrement().primaryKey(),
    bookingId: int('booking_id')
      .notNull()
      .references(() => bookings.id),
    /** The admin who wrote it. Never null — an unattributed note is not auditable. */
    userId: int('user_id')
      .notNull()
      .references(() => users.id),
    note: text('note').notNull(),
    createdAt: datetime('created_at', { mode: 'date' }).notNull(),
  },
  (t) => [index('booking_notes_booking_idx').on(t.bookingId, t.createdAt)],
);

export const couponRedemptions = mysqlTable(
  'coupon_redemptions',
  {
    id: int('id').autoincrement().primaryKey(),
    couponId: int('coupon_id')
      .notNull()
      .references(() => coupons.id),
    bookingId: int('booking_id')
      .notNull()
      .references(() => bookings.id),
    createdAt: datetime('created_at', { mode: 'date' }).notNull(),
  },
  (t) => [
    uniqueIndex('coupon_redemptions_unique').on(t.couponId, t.bookingId),
    index('coupon_redemptions_coupon_idx').on(t.couponId),
  ],
);
```

- [ ] **Step 4: Run the tests, five checks, commit**

```bash
git commit -m "feat(db): booking add-on lines, notes and coupon redemptions"
```

**✅ DONE 10**

---

### Task 11: `trip_checkpoints`, `review_helpful_votes`, the two retro-fitted FKs, then generate Waves 2–4

**Files:**

- Modify: `server/src/db/schema.ts`
- Create: `server/src/db/migrations/0003_*.sql`, `0004_*.sql` (generated)
- Test: `server/src/__tests__/schema-trips.test.ts`

**Interfaces:**

- Consumes: `bookings`, `tour_itinerary_stops` (existing), `reviews` (existing).
- Produces: `tripCheckpoints`, `reviewHelpfulVotes`; FKs added to `reviews.booking_id` and `inquiries.package_id`.

- [ ] **Step 1: Write the failing test**

```ts
describe('trip_checkpoints', () => {
  it('marks an undone check-in rather than deleting it (§8: "marked undone, not deleted")', async () => {
    const [cols] = await getDb().execute(sql`
      SELECT COLUMN_NAME, COLUMN_DEFAULT FROM information_schema.columns
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'trip_checkpoints' AND COLUMN_NAME = 'undone'`);
    expect(cols).toHaveLength(1);
  });

  it('allows a null stop_id, which means "trip start"', async () => {
    const [cols] = await getDb().execute(sql`
      SELECT IS_NULLABLE FROM information_schema.columns
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'trip_checkpoints' AND COLUMN_NAME = 'stop_id'`);
    expect(cols[0]?.IS_NULLABLE).toBe('YES');
  });
});

describe('review_helpful_votes', () => {
  it('accepts one vote per (review, voter) and refuses the second', async () => {
    // insert (review 1, hash 'abc') twice; second rejects /duplicate/i
  });
});
```

- [ ] **Step 2: Run it and watch it fail.**

- [ ] **Step 3: Add both tables and the two FKs**

```ts
export const tripCheckpoints = mysqlTable(
  'trip_checkpoints',
  {
    id: int('id').autoincrement().primaryKey(),
    bookingId: int('booking_id')
      .notNull()
      .references(() => bookings.id),
    /** Null = the "start trip" event, which has no itinerary stop behind it (§8). */
    stopId: int('stop_id').references(() => tourItineraryStops.id),
    /** Server time, never the device's — a phone clock is not evidence. */
    checkedAt: datetime('checked_at', { mode: 'date' }).notNull(),
    /** §8: "Undo last check-in ... marked undone, not deleted". */
    undone: boolean('undone').notNull().default(false),
  },
  (t) => [index('trip_checkpoints_booking_idx').on(t.bookingId, t.checkedAt)],
);

export const reviewHelpfulVotes = mysqlTable(
  'review_helpful_votes',
  {
    reviewId: int('review_id')
      .notNull()
      .references(() => reviews.id),
    /**
     * Hash of cookie id + IP (§4: "one per browser via cookie + IP rate
     * limit"). A hash, not the IP: the raw address is personal data under
     * RA 10173 and this table has no admin screen behind it.
     */
    voterHash: varchar('voter_hash', { length: 64 }).notNull(),
    createdAt: datetime('created_at', { mode: 'date' }).notNull(),
  },
  (t) => [primaryKey({ columns: [t.reviewId, t.voterHash] })],
);
```

Then add `.references(() => bookings.id)` to the existing `reviews.bookingId` column and `.references(() => packages.id)` to `inquiries.packageId`.

- [ ] **Step 4: Generate and apply Waves 2–4, reading the SQL first**

```bash
pnpm --filter @rg/server db:generate
pnpm --filter @rg/server db:migrate
```

Adding an FK to a populated table fails if any existing row violates it. `reviews.booking_id` is all-null in the seed and `inquiries.package_id` points at real packages, so both should apply cleanly — but check, and if the ALTER fails, report rather than deleting rows.

- [ ] **Step 5: Run the five checks and commit**

```bash
git commit -m "feat(db): waves 2-4 — sessions, bookings, lines, trips and votes"
```

**✅ DONE 11**

---

## Phase 3 — Payments, provider-neutral from the first migration (B1a)

**The design rule for this whole phase:** nothing outside `server/src/services/payments/` may name a
gateway. No `paymongo_id` column, no `if (provider === 'paymongo')` in a router, no PayMongo-shaped
JSON leaking into `bookings`. Adding Xendit later should touch exactly two things — a new file in
that directory, and one line in the registry. If a task in this phase makes you write a gateway name
anywhere else, the design is wrong; stop and report rather than working around it.

### Task 12: `payments`, provider-neutral

**Files:**

- Modify: `server/src/db/schema.ts`
- Create: `server/src/db/migrations/0005_*.sql` (generated)
- Test: `server/src/__tests__/schema-payments.test.ts`

**Interfaces:**

- Consumes: `bookings`, `users`, `drivers`, `PAYMENT_PROVIDERS` (Task 6).
- Produces: `payments` table; `PAYMENT_TYPES = ['payment','refund'] as const`,
  `PAYMENT_METHODS = ['card','gcash','maya','grabpay','qrph','bank_transfer','manual_qr','cash'] as const`,
  `PAYMENT_STATUSES = ['pending','paid','rejected','failed','refunded'] as const`.

**`provider` and `method` are two different questions** and the spec's single `method` column
conflated them: it listed `(paymongo/manual_qr/cash)`, mixing "who processed it" with "how the guest
paid". Split, because a GCash payment through PayMongo and a GCash payment through Xendit are the
same instrument and different processors, and reports need both axes (§9 Reports: "Revenue by tour
and by payment method"). This is Open Question Q2 — the plan picks the split and says so.

- [ ] **Step 1: Write the failing test**

```ts
describe('payments', () => {
  it('names no gateway in any column', async () => {
    const [cols] = await getDb().execute(sql`
      SELECT COLUMN_NAME FROM information_schema.columns
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'payments'`);
    const names = cols.map((c) => String(c.COLUMN_NAME).toLowerCase()).join(' ');
    // The whole point of B1a: adding Xendit must need no schema change.
    expect(names).not.toMatch(/paymongo|xendit|stripe/);
    expect(names).toContain('provider');
    expect(names).toContain('provider_ref');
    expect(names).toContain('provider_status');
  });

  it('stores the amount as int centavos', async () => {
    const [cols] = await getDb().execute(sql`
      SELECT DATA_TYPE FROM information_schema.columns
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'payments'
        AND COLUMN_NAME = 'amount_centavos'`);
    expect(cols[0]?.DATA_TYPE).toBe('int');
  });

  it('keeps a refund as its own row, not a booking status', async () => {
    const [cols] = await getDb().execute(sql`
      SELECT COLUMN_TYPE FROM information_schema.columns
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'payments' AND COLUMN_NAME = 'type'`);
    expect(String(cols[0]?.COLUMN_TYPE)).toContain('refund');
  });
});
```

Prove the first test can fail by adding a `paymongo_id` column — it goes red immediately. That test
is the structural guard for this entire phase.

- [ ] **Step 2: Run it and watch it fail.**

- [ ] **Step 3: Add the table**

```ts
export const PAYMENT_TYPES = ['payment', 'refund'] as const;
export const PAYMENT_METHODS = [
  'card',
  'gcash',
  'maya',
  'grabpay',
  'qrph',
  'bank_transfer',
  'manual_qr',
  'cash',
] as const;
export const PAYMENT_STATUSES = ['pending', 'paid', 'rejected', 'failed', 'refunded'] as const;

export const payments = mysqlTable(
  'payments',
  {
    id: int('id').autoincrement().primaryKey(),
    bookingId: int('booking_id')
      .notNull()
      .references(() => bookings.id),

    /** Money IN or money OUT. A refund is a row here, never a booking status (section 6). */
    type: mysqlEnum('type', PAYMENT_TYPES).notNull(),
    /** WHO processed it. Adding a gateway adds an enum value, not a column. */
    provider: mysqlEnum('provider', PAYMENT_PROVIDERS).notNull(),
    /** HOW the guest paid. Orthogonal to `provider` — GCash exists on several. */
    method: mysqlEnum('method', PAYMENT_METHODS).notNull(),

    /**
     * ALWAYS POSITIVE, in centavos. Direction comes from `type`, never from a
     * sign: a negative amount plus a `refund` type is two ways of saying the
     * same thing, and they drift.
     */
    amountCentavos: int('amount_centavos').notNull(),
    /** OUR normalised status. Never the gateway's wording. */
    status: mysqlEnum('status', PAYMENT_STATUSES).notNull().default('pending'),

    /** The gateway's own id for this charge/refund — opaque to us. */
    providerRef: varchar('provider_ref', { length: 191 }),
    /** The gateway's raw status string, kept verbatim for support and reconciliation. */
    providerStatus: varchar('provider_status', { length: 80 }),

    /** Manual QR flow (section 6): guest-entered transaction ref and uploaded receipt. */
    txnRef: varchar('txn_ref', { length: 191 }),
    receiptPath: varchar('receipt_path', { length: 300 }),
    rejectReason: varchar('reject_reason', { length: 400 }),

    /** Set only by an admin approval path. */
    verifiedBy: int('verified_by').references(() => users.id),
    verifiedAt: datetime('verified_at', { mode: 'date' }),
    /** Driver who took cash on tour day (section 8). */
    collectedByDriverId: int('collected_by_driver_id').references(() => drivers.id),

    createdAt: datetime('created_at', { mode: 'date' }).notNull(),
    updatedAt: datetime('updated_at', { mode: 'date' }).notNull(),
  },
  (t) => [
    // The two indexes BUILD_SPEC section 10 names.
    index('payments_booking_idx').on(t.bookingId),
    index('payments_status_idx').on(t.status),
    // Added: reconciling a webhook against an existing row.
    index('payments_provider_ref_idx').on(t.provider, t.providerRef),
  ],
);
```

`receipt_path` stores a path under `/uploads`, which is **outside the web root** and served through
an authenticated route (CLAUDE.md Security). Never store a public URL here.

- [ ] **Step 4: Generate and apply the migration, run the tests, five checks, commit**

```bash
git commit -m "feat(db): provider-neutral payments table"
```

**✅ DONE 12**

---

### Task 13: the `PaymentProvider` interface and the registry

**Files:**

- Create: `server/src/services/payments/types.ts`, `errors.ts`, `registry.ts`, `xendit.ts`
- Test: `server/src/__tests__/payment-registry.test.ts`

**Interfaces:**

- Consumes: `PAYMENT_PROVIDERS` (Task 6), `readSettingBlock` (existing).
- Produces: the types below, plus `getProvider(name): PaymentProvider`,
  `getActiveProvider(): Promise<PaymentProvider>`, `ProviderNotEnabledError`, `UnknownProviderError`.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from 'vitest';
import {
  getProvider,
  UnknownProviderError,
  ProviderNotEnabledError,
} from '../services/payments/registry';

describe('provider registry', () => {
  it('returns an implementation for a known provider', () => {
    expect(getProvider('paymongo').name).toBe('paymongo');
  });

  it('REFUSES an unknown provider rather than defaulting to one', () => {
    // Fail closed: a typo in a webhook URL must not silently route money
    // through whichever gateway happens to be first in the map.
    expect(() => getProvider('stripe' as never)).toThrow(UnknownProviderError);
    expect(() => getProvider('' as never)).toThrow(UnknownProviderError);
    expect(() => getProvider('__proto__' as never)).toThrow(UnknownProviderError);
  });

  it('exposes Xendit, but every method throws ProviderNotEnabledError', async () => {
    const xendit = getProvider('xendit');
    expect(xendit.name).toBe('xendit');
    await expect(xendit.createCheckout({} as never)).rejects.toThrow(ProviderNotEnabledError);
    await expect(xendit.refund({} as never)).rejects.toThrow(ProviderNotEnabledError);
    expect(() => xendit.verifyWebhook(Buffer.from(''), {})).toThrow(ProviderNotEnabledError);
    expect(() => xendit.parseEvent(Buffer.from(''))).toThrow(ProviderNotEnabledError);
  });
});
```

The `__proto__` case is not decoration: a plain-object lookup table returns `Object.prototype` for
that key, which is truthy and would pass a naive `if (!impl) throw`. Prove the test fails by
implementing the registry as `const map = { paymongo, xendit }` with `map[name]`.

- [ ] **Step 2: Run it and watch it fail.**

- [ ] **Step 3: Define the interface**

```ts
// server/src/services/payments/types.ts
import type { PAYMENT_METHODS, PAYMENT_PROVIDERS } from '../../db/schema';

export type ProviderName = (typeof PAYMENT_PROVIDERS)[number];
export type PaymentMethod = (typeof PAYMENT_METHODS)[number];

export interface CreateCheckoutInput {
  /** Public booking ref — goes in the gateway's metadata so the webhook can find us. */
  bookingRef: string;
  /** What the guest owes NOW, in centavos. Computed server-side; never from the browser. */
  amountCentavos: number;
  description: string;
  /** Instruments to offer; a subset of PAYMENT_METHODS the gateway supports. */
  methods: readonly PaymentMethod[];
  successUrl: string;
  cancelUrl: string;
}

export interface CreateCheckoutResult {
  /** Where to send the guest. */
  redirectUrl: string;
  /** The gateway's id for this checkout — stored as payments.provider_ref. */
  providerRef: string;
}

/** What a webhook turned out to be, in OUR vocabulary. */
export interface ParsedPaymentEvent {
  /** The gateway's event id. Unique per provider; drives idempotency. */
  providerEventId: string;
  /** The gateway's event name, kept verbatim for the audit trail. */
  providerType: string;
  /** Normalised outcome. `ignored` means "valid event, nothing for us to do". */
  outcome: 'paid' | 'failed' | 'refunded' | 'ignored';
  bookingRef: string | null;
  amountCentavos: number | null;
  providerRef: string | null;
  providerStatus: string | null;
}

export interface RefundInput {
  providerRef: string;
  amountCentavos: number;
  reason: string;
}

export interface RefundResult {
  providerRef: string;
  providerStatus: string;
}

/**
 * Everything gateway-specific lives behind this interface.
 *
 * Nothing outside server/src/services/payments/ may name a gateway. Adding
 * Xendit for real means writing one file here and flipping one setting — not
 * a migration, not a router change, not a new webhook route shape.
 */
export interface PaymentProvider {
  readonly name: ProviderName;
  createCheckout(input: CreateCheckoutInput): Promise<CreateCheckoutResult>;
  /** Returns false (or throws) on a bad signature. NEVER returns true on doubt. */
  verifyWebhook(rawBody: Buffer, headers: Record<string, string | undefined>): boolean;
  parseEvent(rawBody: Buffer): ParsedPaymentEvent;
  refund(input: RefundInput): Promise<RefundResult>;
}
```

- [ ] **Step 4: Implement the registry and the Xendit stub**

```ts
// server/src/services/payments/registry.ts
import { readSettingBlock } from '../../content/settings';
import { paymongoProvider } from './paymongo';
import { xenditProvider } from './xendit';
import { UnknownProviderError } from './errors';
import type { PaymentProvider, ProviderName } from './types';

/**
 * A Map, not an object literal: `map['__proto__']` on a plain object returns
 * Object.prototype — truthy, not a provider, and it would sail past a
 * `if (!impl) throw` check. This is the one place a provider name becomes code.
 */
const PROVIDERS = new Map<ProviderName, PaymentProvider>([
  ['paymongo', paymongoProvider],
  ['xendit', xenditProvider],
]);

export function getProvider(name: ProviderName): PaymentProvider {
  const impl = PROVIDERS.get(name);
  if (!impl) throw new UnknownProviderError(name);
  return impl;
}

/**
 * The gateway the admin has switched on, from settings — never from the
 * request, so a caller cannot choose its own processor. `manual` is absent on
 * purpose: a manual QR payment has no gateway to call.
 */
export async function getActiveProvider(): Promise<PaymentProvider> {
  const block = await readSettingBlock('payments');
  return getProvider(block.activeProvider);
}
```

```ts
// server/src/services/payments/xendit.ts
import { ProviderNotEnabledError } from './errors';
import type { PaymentProvider } from './types';

/**
 * Xendit is planned, not enabled (B1a). Every method throws, loudly.
 *
 * It exists so the seam is real rather than theoretical: the registry, the
 * webhook route and the settings enum all carry a second provider from day
 * one, so adding the real implementation is filling this file in — not
 * discovering that the abstraction never worked.
 *
 * It must NEVER be able to mark anything paid. There is a test for that.
 */
function notEnabled(): never {
  throw new ProviderNotEnabledError('xendit');
}

export const xenditProvider: PaymentProvider = {
  name: 'xendit',
  createCheckout: async () => notEnabled(),
  verifyWebhook: () => notEnabled(),
  parseEvent: () => notEnabled(),
  refund: async () => notEnabled(),
};
```

- [ ] **Step 5: Run the tests, five checks, commit**

```bash
git commit -m "feat(payments): PaymentProvider seam, registry and the Xendit stub"
```

**✅ DONE 13**

---

### Task 14: `recordPayment()` — the only thing that can mark a booking paid

**Files:**

- Create: `server/src/services/payments/record-payment.ts`
- Test: `server/src/__tests__/record-payment.test.ts`

**Interfaces:**

- Consumes: `payments`, `bookings`, `writeAudit` (Task 2).
- Produces: `recordPayment(input): Promise<{ paymentId: number; bookingStatus: BookingStatus }>`.

Section 6 and CLAUDE.md: "Only a verified PayMongo webhook or an admin approval does that" —
generalised by B1a to every provider. This function is where that rule lives, and the webhook route
and the admin approval procedure are its only two callers.

- [ ] **Step 1: Write the failing test**

```ts
describe('recordPayment', () => {
  it('marks the booking confirmed and writes an audit row, in one transaction', async () => {
    const { bookingId } = await seedPendingBooking({ totalCentavos: 189000 });
    const result = await recordPayment({
      bookingId,
      type: 'payment',
      provider: 'paymongo',
      method: 'gcash',
      amountCentavos: 189000,
      providerRef: 'pi_test',
      providerStatus: 'paid',
      actor: { type: 'system', id: null },
    });
    expect(result.bookingStatus).toBe('confirmed');
    const [audit] = await db.execute(
      sql`SELECT action FROM audit_log WHERE entity='payments' AND entity_id=${result.paymentId}`,
    );
    expect(audit).toHaveLength(1);
  });

  it('REFUSES an amount that does not match what the booking expects', async () => {
    const { bookingId } = await seedPendingBooking({ totalCentavos: 189000 });
    await expect(
      recordPayment({
        bookingId,
        type: 'payment',
        provider: 'paymongo',
        method: 'gcash',
        amountCentavos: 100,
        providerRef: 'pi_short',
        providerStatus: 'paid',
        actor: { type: 'system', id: null },
      }),
    ).rejects.toThrow(/amount/i);
    // And nothing was written — it must fail closed, not half-apply.
    const [rows] = await db.execute(sql`SELECT id FROM payments WHERE provider_ref='pi_short'`);
    expect(rows).toHaveLength(0);
  });

  it('leaves the booking untouched when the payment insert fails', async () => {
    // Force a failure after the payments insert and assert bookings.status
    // is still pending_payment and amount_paid_centavos is still 0.
  });
});
```

- [ ] **Step 2: Run it and watch it fail.**

- [ ] **Step 3: Implement**

```ts
/**
 * The ONLY path that moves money onto a booking.
 *
 * Two callers, ever: the verified-webhook route and the admin approval
 * procedure. Not the success-redirect page (section 6: "The success redirect
 * page only reads status ... It never confirms anything itself"), not the
 * client, not a provider implementation.
 *
 * Everything happens in one transaction: insert the payment, move
 * amount_paid, move the booking status, write the audit row. A partial
 * application here is a booking that took money and does not know it.
 */
export async function recordPayment(input: RecordPaymentInput): Promise<RecordPaymentResult> {
  return getDb().transaction(async (tx) => {
    const [booking] = await tx
      .select()
      .from(bookings)
      .where(eq(bookings.id, input.bookingId))
      .for('update');
    if (!booking) throw new Error('Booking not found.');

    if (input.type === 'payment') {
      const expected = expectedAmountCentavos(booking); // total or deposit, per pay_mode
      if (input.amountCentavos !== expected) {
        throw new PaymentAmountMismatchError(expected, input.amountCentavos);
      }
    }

    // insert payments row, update amount_paid_centavos and status, then:
    await writeAudit(tx, {
      actorType: input.actor.type,
      actorId: input.actor.id,
      action: input.type === 'refund' ? 'payment.refunded' : 'payment.recorded',
      entity: 'payments',
      entityId: paymentId,
      data: {
        bookingRef: booking.ref,
        amountCentavos: input.amountCentavos,
        provider: input.provider,
      },
    });
    return { paymentId, bookingStatus: nextStatus };
  });
}
```

The row lock (`.for('update')`) is required: two webhook deliveries for the same booking arriving
together would otherwise both read `amount_paid = 0` and both add to it.

- [ ] **Step 4: Run the tests, five checks, commit**

```bash
git commit -m "feat(payments): one transactional path to mark a booking paid"
```

**✅ DONE 14**

---

### Task 15: the webhook route, one per provider

**Files:**

- Create: `server/src/routers/webhooks/index.ts`
- Modify: `server/src/app.ts`
- Test: `server/src/__tests__/webhooks.test.ts`

**Interfaces:**

- Consumes: `getProvider` (Task 13), `recordPayment` (Task 14), `paymentEvents` (Task 6).
- Produces: `POST /api/webhooks/:provider`.

**Mount order matters.** This route needs the **raw body** for signature verification, so it must be
mounted with `express.raw({ type: '*/*' })` BEFORE any JSON body parser sees it. It also sits above
the SPA catch-all, like `/robots.txt` and `/sitemap.xml` — `app.ts` already carries a comment block
explaining that ordering, and task 4.3b's malformed-URL guard stays above everything.

- [ ] **Step 1: Write the failing test**

```ts
describe('POST /api/webhooks/:provider', () => {
  it('rejects an unknown provider without reading the body', async () => {
    const res = await request(app).post('/api/webhooks/stripe').send({ any: 'thing' });
    expect(res.status).toBe(404);
    expect(JSON.stringify(res.body)).not.toMatch(/paymongo|xendit/);
  });

  it('rejects a bad signature with 400 and records nothing', async () => {
    const res = await request(app)
      .post('/api/webhooks/paymongo')
      .set('paymongo-signature', 'nonsense')
      .send(validPaidPayload);
    expect(res.status).toBe(400);
    const [events] = await db.execute(sql`SELECT id FROM payment_events`);
    expect(events, 'a bad-signature event was stored').toHaveLength(0);
    const [paid] = await db.execute(sql`SELECT id FROM payments`);
    expect(paid, 'a bad-signature webhook created a payment').toHaveLength(0);
  });

  it('is idempotent: the same event twice pays once', async () => {
    const send = () =>
      request(app)
        .post('/api/webhooks/paymongo')
        .set('paymongo-signature', signFixture(validPaidPayload))
        .send(validPaidPayload);
    const first = await send();
    const second = await send();
    expect(first.status).toBe(200);
    expect(second.status).toBe(200); // ack, so the gateway stops retrying
    const [rows] = await db.execute(sql`SELECT id FROM payments WHERE provider_ref='pi_test'`);
    expect(rows, 'a duplicate webhook created a second payment').toHaveLength(1);
  });

  it('cannot mark anything paid through the Xendit stub', async () => {
    const res = await request(app).post('/api/webhooks/xendit').send(validPaidPayload);
    expect(res.status).toBeGreaterThanOrEqual(400);
    const [rows] = await db.execute(sql`SELECT id FROM payments`);
    expect(rows, 'the disabled provider recorded a payment').toHaveLength(0);
  });
});
```

Every one of these asserts on the **database**, not just the status code. A webhook test that only
checks `res.status` passes happily while money moves — prove each by removing the corresponding
guard and watching the row-count assertion go red, not the status one.

- [ ] **Step 2: Run it and watch it fail.**

- [ ] **Step 3: Implement**

Shape, in order, failing closed at every step:

1. `getProvider(req.params.provider)` inside a try — `UnknownProviderError` → **404**, before the
   body is touched.
2. `provider.verifyWebhook(rawBody, req.headers)` — false or throw → **400**, nothing stored.
   `ProviderNotEnabledError` → **503**, nothing stored.
3. `provider.parseEvent(rawBody)` → `ParsedPaymentEvent`.
4. `INSERT INTO payment_events` — on `ER_DUP_ENTRY` against the `(provider, provider_event_id)`
   unique index, this is a replay: **200** immediately, do nothing else. The idempotency gate is the
   database's unique index, not an application-level `SELECT` first, which races.
5. Only for `outcome === 'paid' | 'refunded'`, call `recordPayment()`.
6. Stamp `processed_at` and return **200**.

Return a bare `{ ok: true }` — never an error detail, a stack, or the parsed event. The tRPC
`errorFormatter` (BUG-102) does not cover this route; it is plain Express.

- [ ] **Step 4: Run the tests, five checks, commit**

```bash
git commit -m "feat(payments): one signed, idempotent webhook route per provider"
```

**✅ DONE 15**

---

### Task 16: PayMongo implementation

**Files:**

- Create: `server/src/services/payments/paymongo.ts`
- Modify: `.env.example`, `server/src/env.ts`
- Test: `server/src/__tests__/paymongo-provider.test.ts`

**Interfaces:**

- Consumes: `PaymentProvider` (Task 13).
- Produces: `paymongoProvider: PaymentProvider`.

Env: `PAYMONGO_SECRET_KEY`, `PAYMONGO_WEBHOOK_SECRET`. Both optional in `env.ts` — the app must boot
without them, as it does today — but `createCheckout` throws a clear error when the key is absent,
so a misconfigured deploy fails at the first payment rather than silently at boot.

- [ ] **Step 1: Write the failing test.** Signature verification is the critical unit. Cover: a
      known-good fixture signature; a tampered body; a tampered signature; a missing header; and a
      well-formed signature computed with the wrong secret. All but the first must be rejected. The
      implementation compares with `crypto.timingSafeEqual` after a length check, never `===`.

- [ ] **Step 2: Run it and watch it fail.**

- [ ] **Step 3: Implement** with plain `fetch` against PayMongo's REST API — **no SDK** (Global
      Constraints). `createCheckout` POSTs a Checkout Session with `amount` in centavos (PayMongo's unit
      is already centavos, so there is no conversion to get wrong), the booking ref in `metadata`, and
      the allowed methods. `parseEvent` maps PayMongo event types onto our `outcome` vocabulary and
      returns `ignored` for anything we do not act on — it must never throw on an unrecognised event, or
      a newly introduced PayMongo event type would 500 the webhook and trigger infinite retries.

- [ ] **Step 4: Run the tests, five checks, commit**

```bash
git commit -m "feat(payments): PayMongo provider over plain fetch, no SDK"
```

**✅ DONE 16**

---

## Phase 4 — Guards and role isolation

### Task 17: `requireRole()` and a test per role per area

**Files:**

- Create: `server/src/middleware/require-role.ts`
- Test: `server/src/__tests__/role-isolation.test.ts`

**Interfaces:**

- Consumes: `ADMIN_ROLES` (Task 1), `sessions` (Task 7).
- Produces: `requireRole(...roles: AdminRole[])`, `ROLE_MATRIX`.

CLAUDE.md: "Role middleware on every admin procedure, plus a test per role per area." The matrix is
section 9's table, transcribed exactly once:

```ts
/** BUILD_SPEC section 9 "Roles & permissions", transcribed verbatim. */
export const ROLE_MATRIX = {
  dashboard: ['owner', 'dispatcher', 'finance'],
  bookingsView: ['owner', 'dispatcher', 'finance'],
  assignVanDriver: ['owner', 'dispatcher'],
  verifyPayments: ['owner', 'finance'],
  cancelRefund: ['owner', 'finance'],
  vansDrivers: ['owner', 'dispatcher'],
  toursPricing: ['owner'],
  reviewsModeration: ['owner', 'dispatcher'],
  reports: ['owner', 'finance'],
  usersSettings: ['owner'],
} as const satisfies Record<string, readonly AdminRole[]>;
```

- [ ] **Step 1: Write the failing test** — iterate the matrix and assert BOTH directions for all
      three roles across all ten areas (30 generated cases):

```ts
for (const [area, allowed] of Object.entries(ROLE_MATRIX)) {
  for (const role of ADMIN_ROLES) {
    const shouldPass = (allowed as readonly string[]).includes(role);
    it(`${role} is ${shouldPass ? 'allowed' : 'DENIED'} in ${area}`, async () => {
      const result = await callArea(area, { role });
      expect(result.ok).toBe(shouldPass);
    });
  }
}
```

The denial direction is the one that matters, and it is the one a hand-written test set usually
omits. Prove the loop can fail by making `requireRole` always pass — exactly the 13 denial cases go
red while the 17 allow cases stay green.

- [ ] **Steps 2–4: Implement, verify, commit**

```bash
git commit -m "feat(auth): role matrix with a test per role per area"
```

**✅ DONE 17**

---

### Task 18: convention guard tests

**Files:**

- Test: `server/src/__tests__/schema-conventions.test.ts`

In the spirit of `no-red.test.ts` and `contrast.test.ts`: read the real source, not a fixture list.

- [ ] **Step 1: Write the failing tests**

```ts
const SCHEMA = readFileSync(join(__dirname, '../db/schema.ts'), 'utf8');

it('uses no floating-point or decimal column anywhere — money is int centavos', () => {
  expect(SCHEMA).not.toMatch(/\b(decimal|float|double)\s*\(/);
});

it('uses datetime, never timestamp (which MySQL shifts by session time zone)', () => {
  expect(SCHEMA).not.toMatch(/\btimestamp\s*\(/);
});

it('names every money column *_centavos', () => {
  const money = [
    ...SCHEMA.matchAll(/int\('([a-z_]*(?:price|amount|total|subtotal|discount|spend)[a-z_]*)'\)/g),
  ].map((m) => m[1]);
  expect(money.length).toBeGreaterThan(5); // the scan actually found something
  expect(money.filter((n) => !n.endsWith('_centavos'))).toEqual([]);
});

it('never hard-deletes a booking or a payment anywhere in the server source', () => {
  const offenders = serverSourceFiles().filter((f) =>
    /\.delete\(\s*(bookings|payments)\s*\)/.test(readFileSync(f, 'utf8')),
  );
  expect(offenders, 'bookings and payments are never hard-deleted').toEqual([]);
});
```

The third test's `expect(money.length).toBeGreaterThan(5)` is the vacuity guard — without it, a
regex that stops matching makes the whole assertion pass on an empty array. This project has found
twelve tests that could not fail; most were this shape.

- [ ] **Steps 2–4: Verify each can fail, run the five checks, commit**

```bash
git commit -m "test(db): guard the money, time and soft-delete conventions in source"
```

**✅ DONE 18**

---

---

### Task 19: `depositCentavos()` — rounding, decided and pinned

**Files:**

- Modify: `shared/src/money.ts`
- Test: `shared/src/__tests__/money.test.ts` (extend the existing file)

**Interfaces:**

- Produces: `depositCentavos(totalCentavos: number, depositPercent: number): number`.

No dependency on any other task — can run at any point.

**Owner decision, 2026-10-11 (answers Q4).** The deposit rounds **UP to the next whole peso**:
compute `total × percent / 100`, then ceil to a multiple of 100 centavos. The spec's phrasing said
both "ceil" and "to the nearest whole peso", which disagree on anything with centavos; **ceil wins**.
Computed **server-side only** — the browser never sends a deposit, and nothing in `/client` may
reimplement this (Global Constraints: "The server computes all money").

- [ ] **Step 1: Write the failing test** — boundaries are the whole point here, so they are
      enumerated rather than sampled:

```ts
import { depositCentavos } from '../money';

describe('depositCentavos', () => {
  // ₱1,890.00 at 30% = ₱567.00 exactly — already whole, must not move.
  it('leaves an exact whole peso alone', () => {
    expect(depositCentavos(189000, 30)).toBe(56700);
  });

  // ₱1,895.00 at 30% = ₱568.50 -> ceil -> ₱569.00
  it('rounds a half peso UP', () => {
    expect(depositCentavos(189500, 30)).toBe(56900);
  });

  // ₱1,894.00 at 30% = ₱568.20 -> ceil -> ₱569.00.
  // This is the case where "ceil" and "to the nearest whole peso" disagree:
  // nearest would give ₱568.00. The owner chose ceil (2026-10-11).
  it('rounds UP even when the nearest whole peso is DOWN', () => {
    expect(depositCentavos(189400, 30)).toBe(56900);
  });

  // One centavo over a whole peso still rounds up a full peso.
  it('rounds up from a single centavo', () => {
    expect(depositCentavos(100 * 100 + 1, 100)).toBe(10100);
  });

  it('never exceeds the total', () => {
    // 100% of a total that is not a whole peso would ceil ABOVE the total
    // without a clamp, and a deposit larger than the price is nonsense.
    expect(depositCentavos(10050, 100)).toBe(10050);
  });

  it('returns 0 for a 0% deposit and the total for 100% of a whole peso', () => {
    expect(depositCentavos(189000, 0)).toBe(0);
    expect(depositCentavos(189000, 100)).toBe(189000);
  });

  it('returns an integer for every percent from 0 to 100', () => {
    for (let pct = 0; pct <= 100; pct += 1) {
      const d = depositCentavos(189437, pct);
      expect(Number.isInteger(d), `percent ${pct} produced ${d}`).toBe(true);
      expect(d % 100 === 0 || d === 189437).toBe(true); // whole pesos, or the clamp
    }
  });
});
```

- [ ] **Step 2: Run it and watch it fail** — `depositCentavos` is not exported.

- [ ] **Step 3: Implement**

```ts
/**
 * The deposit due now, in centavos, rounded UP to the next whole peso.
 *
 * BUILD_SPEC §5 says "ceil(total * deposit_percent / 100) to the nearest
 * whole peso", which is two different instructions: on a ₱568.20 deposit,
 * ceil gives ₱569 and nearest gives ₱568. The owner settled it on
 * 2026-10-11 — **ceil**, so the business is never short.
 *
 * Clamped to the total: at 100% of a non-whole-peso total, ceiling would
 * otherwise produce a deposit larger than the price.
 *
 * Integer arithmetic throughout. No floats touch money — `0.1 + 0.2` is the
 * reason this function exists rather than a one-liner at each call site.
 */
export function depositCentavos(totalCentavos: number, depositPercent: number): number {
  const raw = Math.ceil((totalCentavos * depositPercent) / 100); // centavos, not yet whole pesos
  const wholePesos = Math.ceil(raw / 100) * 100;
  return Math.min(wholePesos, totalCentavos);
}
```

- [ ] **Step 4: Prove each boundary test can fail** — swap `Math.ceil` for `Math.round` in the
      second ceil and confirm the "rounds UP even when the nearest whole peso is DOWN" case goes
      red while the others stay green. Remove the clamp and confirm "never exceeds the total" goes
      red. Restore.

- [ ] **Step 5: Run the five checks and commit**

```bash
git commit -m "feat(money): deposit rounds up to the next whole peso"
```

**✅ DONE 19**

---

### Task 20: an app-level Express error handler

**Files:**

- Create: `server/src/middleware/error-handler.ts`
- Modify: `server/src/app.ts`
- Test: `server/src/__tests__/error-handler.test.ts`

**Interfaces:**

- Produces: `errorHandler(err, req, res, next)` — Express's four-argument error middleware.

**Owner-approved addition, 2026-10-11.** Two leaks are already closed —
`middleware/malformed-url.ts` (task 4.3b) handles undecodable URLs, and the tRPC `errorFormatter`
(BUG-102) strips stacks from procedure errors. Neither covers an unhandled throw in plain Express:
that still reaches **finalhandler**, which in a non-production `NODE_ENV` renders an HTML page
**containing the stack trace**. This task closes that last door.

- [ ] **Step 1: Write the failing test**

```ts
import request from 'supertest';

describe('app-level error handler', () => {
  it('turns an unhandled throw into a clean 500 with no stack and no paths', async () => {
    const app = createApp(); // with a test-only route that throws
    const res = await request(app).get('/__throw');

    expect(res.status).toBe(500);
    const body = JSON.stringify(res.body) + res.text;
    expect(body).not.toMatch(/\bat \S+ \(/); // stack frames
    expect(body).not.toMatch(/node_modules|[A-Za-z]:\\|\/(usr|var|home)\//); // paths
    expect(body).not.toMatch(/\.[cm]?[jt]sx?:\d+:\d+/); // file:line:col
    expect(body).not.toMatch(/Error: /); // the raw message
    expect(res.body).toEqual({ error: 'Internal Server Error' });
  });

  it('answers JSON, never finalhandler HTML', async () => {
    const res = await request(app).get('/__throw');
    expect(res.headers['content-type']).toMatch(/application\/json/);
    expect(res.text).not.toMatch(/<html|<pre>/i);
  });

  it('logs the real error server-side, with the stack intact', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    await request(app).get('/__throw');
    expect(spy, 'the error was swallowed entirely — nothing to debug from').toHaveBeenCalled();
    expect(String(spy.mock.calls[0])).toMatch(/__throw|boom/);
    spy.mockRestore();
  });

  it('leaves an already-sent response alone', async () => {
    // A throw AFTER headers are flushed must delegate to Express's default
    // handler, not try to write a second set of headers.
    const res = await request(app).get('/__throw-after-send');
    expect(res.status).toBe(200);
  });

  it('does not shadow the routes that handle their own errors', async () => {
    expect((await request(app).get('/trpc/%zz')).status).toBe(400); // task 4.3b
    expect((await request(app).get('/robots.txt')).status).toBe(200);
    expect((await request(app).get('/api/health')).status).toBe(200);
  });
});
```

The third test matters as much as the first: an error handler that hides the error from the client
**and** from the server log has not improved anything, it has only made the next outage harder.

- [ ] **Step 2: Run it and watch it fail** — finalhandler returns HTML with a stack, so the first
      two assertions go red.

- [ ] **Step 3: Implement**

```ts
import type { ErrorRequestHandler } from 'express';

/**
 * The last middleware in the stack: anything thrown that nothing else caught
 * ends here.
 *
 * Without it, Express hands the error to `finalhandler`, which outside
 * `NODE_ENV=production` replies with an HTML page containing the stack trace
 * — absolute filesystem paths included — to whoever made the request. That
 * is the same leak BUG-102 closed for tRPC procedures and task 4.3b closed
 * for malformed URLs, reached through a third door.
 *
 * Applied in EVERY environment, not just production. "It only leaks in
 * development" stopped being a boundary the moment `pnpm dev:lan` existed.
 *
 * The real error is logged server-side with its stack. The client gets a
 * fixed string and nothing else — no message, because an arbitrary internal
 * error's message is not a safe-by-construction string (`ENOENT: ... open
 * '/var/www/...'` is a message).
 */
export const errorHandler: ErrorRequestHandler = (err, req, res, next) => {
  // Headers already flushed: Express's default handler must take it from
  // here, because writing a second status would throw inside the handler.
  if (res.headersSent) return next(err);

  console.error(`[error] ${req.method} ${req.path}`, err);
  res.status(500).json({ error: 'Internal Server Error' });
};
```

- [ ] **Step 4: Mount it LAST in `server/src/app.ts`**

After every route, including the SPA catch-all. `app.ts` already carries a comment block explaining
why `/robots.txt` and `/sitemap.xml` sit above `app.get('*splat')`; add a line there noting that the
error handler must stay at the very bottom, because Express only treats a four-argument middleware
as an error handler and only reaches it after the routes.

- [ ] **Step 5: Prove each test can fail** — remove the mount and confirm the HTML/stack assertions
      go red; remove the `console.error` and confirm the logging test goes red; remove the
      `headersSent` guard and confirm the already-sent test goes red. Restore.

- [ ] **Step 6: Run the five checks and commit**

```bash
git commit -m "fix(server): unhandled errors return a clean 500, never finalhandler's stack page"
```

**✅ DONE 20**

## Which test proves which constraint

| Constraint                                                        | Proven by                                                                                                                                                                 |
| ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Money is centavos, no decimals                                    | Task 18 source guard + per-table `information_schema` assertions (Tasks 3, 5, 8, 12)                                                                                      |
| Times are UTC `datetime`, never `timestamp`                       | Task 18 source guard + Task 7 `expires_at` assertion                                                                                                                      |
| Booking refs are random, non-sequential, crypto-sourced           | Task 9 — four tests, including the `Math.random` spy                                                                                                                      |
| A ref collision cannot lose a booking                             | Task 9 `insertBookingWithRef` retry test                                                                                                                                  |
| Soft deletes only; bookings/payments never hard-deleted           | Task 18 source guard                                                                                                                                                      |
| The capacity-holding status set is exactly the spec's             | Task 8                                                                                                                                                                    |
| A coupon can never hold a malformed discount                      | Task 5 — four rejection tests against the database CHECK, issued as raw SQL so they bypass Zod                                                                            |
| The deposit rounds UP to a whole peso and never exceeds the total | Task 19 — enumerated boundaries, including the ₱568.20 case where ceil and nearest disagree                                                                               |
| An audit row shares the transaction it describes                  | Task 2 rollback test                                                                                                                                                      |
| Payments name no gateway                                          | Task 12 column-name scan                                                                                                                                                  |
| Webhook idempotency                                               | Task 6 unique index + Task 15 duplicate delivery                                                                                                                          |
| A bad signature cannot pay                                        | Task 15, asserting on the `payments` row count                                                                                                                            |
| An unknown provider cannot pay                                    | Tasks 13 and 15                                                                                                                                                           |
| The Xendit stub cannot pay                                        | Tasks 13 and 15                                                                                                                                                           |
| Only a verified webhook or an admin marks paid                    | Task 14 (two callers) + Task 15                                                                                                                                           |
| The amount must match what the booking expects                    | Task 14                                                                                                                                                                   |
| Role isolation, both directions                                   | Task 17 — 30 generated cases                                                                                                                                              |
| A session token is never stored raw                               | Task 7                                                                                                                                                                    |
| A driver PIN is never stored raw                                  | Task 4                                                                                                                                                                    |
| No unhandled error ever returns a stack or a path                 | Task 20 — plus BUG-102's tRPC formatter and task 4.3b's URL guard, already shipped                                                                                        |
| Capacity never oversells the fleet                                | **The capacity service is Week 3, not this plan.** This plan provides the lock rows and the status set it needs (Tasks 6, 8); the concurrency test lives with the service |

---

## Open questions

Four are now **answered** and folded into the tasks above. Nine remain. Where this plan had to pick
something to be writable at all, the pick is marked **[provisional]** — a starting point for your
answer, not a decision.

### ✅ ANSWERED — Q4: deposit rounding (owner, 2026-10-11)

**Round the deposit UP to the next whole peso** (ceil to 100 centavos). Server-computed only, with
boundary tests. Folded into **Task 19**, which pins the ₱568.20 case where the spec's own "ceil" and
"to the nearest whole peso" disagree — ceil wins — and clamps the result so a 100% deposit on a
non-whole-peso total cannot exceed the total.

### ✅ ANSWERED — Q6: coupon discount shape (owner, 2026-10-11)

The single `value` column is **replaced** by `discount_type enum('percent','fixed')`,
`percent_bp int NULL` (basis points, 1000 = 10%) and `amount_centavos int NULL`, with a **CHECK**
that exactly one is set and matches `discount_type`. Folded into **Task 5**, which verifies the
constraint is actually live in `information_schema.check_constraints` (MySQL silently ignores CHECK
before 8.0.16 — this server is 8.0.46, confirmed) and proves rejection with raw SQL that bypasses
Zod entirely.

### ✅ ANSWERED — Q7: capacity rule (owner, 2026-10-11) — _pending R&G confirmation_

**Each booked group requires one van.** Per tour per day, accept bookings up to
`MIN(tour.groups_per_day, vans free that day across all tours)`. **Never overbook automatically.**
An admin may manually override with a reason, and the override writes to `audit_log`.

Marked **"pending R&G confirmation"** in BUILD_SPEC §5, and built to this rule meanwhile.

Two consequences, both folded in:

1. **The fleet constraint is global across tours, so the lock must be too** — this is new, and it
   is Q14 below.
2. The override needs an audit action (`booking.capacity_override`) carrying the reason. No new
   column: §10 gives `bookings` none, and `audit_log` already records actor, action and free-form
   `data`. The cost is that "which bookings were overridden?" becomes an `audit_log` query rather
   than a column filter — acceptable for what should be a rare, deliberate act.

### ✅ APPROVED — app-level Express error handler (owner, 2026-10-11)

Added as **Task 20**. No finalhandler dev HTML, no stack traces, server-side logging kept, with
tests that can fail.

---

### 🔴 Q14 — NEW, raised by the Q7 answer: what serialises the cross-tour fleet check?

**This one needs an answer before Task 6 is built**, because it decides whether there is a 17th
table.

"Vans free that day **across all tours**" makes the fleet a shared, date-global resource. The lock
the spec designed is per **tour** and date — `tour_date_slots (tour_id, date)`. Two bookings for
**different tours** on the same date lock **different rows**, so they do not exclude each other,
and both can pass "a van is free" and take the same last van. The spec's lock cannot enforce the
rule you have just chosen.

Three ways out:

| Option                                                                                                                 | What it costs                                                                                                                                                                                         |
| ---------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **A. Add `fleet_date_slots (date)`** — one row per date, locked `FOR UPDATE` before any capacity check. _Recommended._ | A 17th table, beyond the 16 this plan scoped. Serialises all bookings sharing a date across tours — with six tours and a small fleet, that is a handful of rows a day, so the throughput cost is nil. |
| **B. Repurpose `tour_date_slots`** to be keyed by date alone                                                           | Contradicts §10, which names it and keys it by `(tour_id, date)`. Drops the per-tour row the spec asked for.                                                                                          |
| **C. Lock the `vans` rows** with `SELECT … FOR UPDATE`                                                                 | No new table, but it range-locks over "available vans" and InnoDB gap locks there deadlock readily under concurrent inserts. Hardest to get right and to test.                                        |

**My recommendation is A**, with locks always taken in a fixed order (`fleet_date_slots` first, then
`tour_date_slots`) so two concurrent bookings can never deadlock by grabbing them in opposite
orders. **Confirm A, B or C** — the plan currently documents A as provisional in Task 6 and does not
build it.

### Q1 — What is a customer session's `subject_id`? **[provisional: the booking id]**

§10 gives `sessions` a `subject_type (admin/customer/driver)` and a `subject_id`, but customers have
no row of their own — §7 logs them in with booking ref + email and says the session is "scoped to
that booking only". The plan reads `subject_id` as `bookings.id` for `subject_type='customer'`.

The alternative is a `customers` table keyed by email, with sessions pointing at it. That would let
a repeat guest see all their bookings in one portal, which §7 does not ask for and arguably forbids.
**Confirm: one session per booking, no customer accounts?**

Note the enum: §10 writes `admin` where §9 calls the role `owner`. The plan uses `user` for the
admin subject type, matching the `users` table. Flag if you want `admin`.

### Q2 — Does splitting `payments.method` into `provider` + `method` suit you? **[provisional: yes, split]**

§10's `payments.method (paymongo/manual_qr/cash)` mixes the processor with the instrument. B1a
requires a provider-neutral table, so the plan splits them: `provider` ∈ (paymongo, xendit, manual)
and `method` ∈ (card, gcash, maya, grabpay, qrph, bank_transfer, manual_qr, cash).

This matters for §9's "Revenue by tour and by payment method" report — with the split you can ask
both "how much through PayMongo" and "how much by GCash", which the single column cannot answer.
**Confirm the two enum value lists**, particularly whether `bank_transfer` is needed at launch.

### Q3 — Is the `paymongo_events` → `payment_events` rename approved? **[provisional: yes, per B1a]**

B1a asks for "a `payment_events` (or equivalent) table with UNIQUE(provider, provider_event_id)",
which is incompatible with the spec's PayMongo-specific `paymongo_events (event_id unique)`. The
plan renames it, and the 2026-10-10 spec amendment already reflects that. This is the **only**
deviation from the §10 table list. **Confirm.**

### Q5 — What exactly goes in `bookings.price_snapshot`? **[provisional: see below]**

§5 says "Store a price snapshot on the booking (tier price, add-on prices, coupon, totals)" without
fixing the shape. The plan proposes:

```json
{
  "tier": { "minPax": 4, "maxPax": 6, "pricePerPersonCentavos": 189000 },
  "pax": 4,
  "addons": [
    { "addonId": 3, "name": "Lunch", "priceCentavos": 35000, "perPerson": true, "qty": 4 }
  ],
  "coupon": { "id": 7, "code": "SAVE10", "discountType": "percent", "percentBp": 1000 },
  "depositPercent": 30,
  "subtotalCentavos": 896000,
  "discountCentavos": 89600,
  "totalCentavos": 806400,
  "computedAt": "2026-10-11T08:00:00.000Z"
}
```

(The `coupon` block now carries `discountType`/`percentBp` per the Q6 answer.)

Once bookings exist this shape is effectively permanent, because old rows keep whatever was written.
**Confirm, or amend now.** In particular: should it also freeze `free_cancel_hours`, so a later
change to the tour's cancellation window cannot alter an existing booking's refund rights? The plan
thinks yes, and §6's "Free-cancellation policy window is a tour setting" does not say.

### Q8 — When is a `tour_date_slots` row created? **[provisional: on demand, idempotently]**

§10 calls it a "lock row for capacity checks" without saying who creates it. The plan creates it at
the start of the booking transaction with `INSERT … ON DUPLICATE KEY UPDATE tour_id = tour_id` (a
no-op touch that is safe when two requests race), then `SELECT … FOR UPDATE`. The alternative —
pre-creating a row per tour per bookable date — needs a job and a horizon and can run out.
**Confirm the on-demand approach.** If Q14 resolves to option A, the same pattern applies to
`fleet_date_slots`.

### Q9 — What are the driver lockout numbers? **Not guessed**

§10 gives `drivers` `failed_attempts` and `locked_until`, and §12's security checklist asks for rate
limits, but no number is given for the driver PIN specifically. §7 gives the _customer_ portal "5
failed attempts per IP per 15 minutes"; §8 gives the driver portal nothing.

**How many failed PINs before lockout, and for how long?** A 4-digit PIN brute-forces in 10,000
tries, so this number is doing real work. The columns exist either way; the policy does not.

### Q10 — Are these the right `audit_log.actor_type` values? **[provisional: user/customer/driver/system]**

§10 says `actor_type` without enumerating it. The plan uses `user` (an admin), `customer`, `driver`,
and `system` (cron, webhook — no human). `system` matters: a hold expiring or a webhook confirming a
payment has no actor, and leaving `actor_id` null with `actor_type='user'` would read as "an admin
did this". **Confirm the four.**

### Q11 — Should a refund be a positive amount with `type='refund'`? **[provisional: yes, always positive]**

§10 gives `payments` a `type (payment/refund)` and an `amount`, and §6 says "Refunds are tracked on
payments, not as a booking status". It does not say whether a refund's amount is negative.

The plan stores **always-positive** amounts and takes direction from `type`, because a signed amount
plus a type is two representations of one fact and they drift — and a `SUM(amount)` that silently
mixes them is a reporting bug waiting to happen. **Confirm**, and also confirm whether **partial**
refunds are allowed (§6 says "full, partial, none", so the plan assumes yes, meaning several refund
rows can exist for one booking and their sum must never exceed `amount_paid`).

### Q12 — Does `reviews.booking_id` become a real foreign key now?

The column exists today as a bare nullable `int`. Wave 3 adds the FK. §10 describes it as "null if
unverified", which the FK allows. The only risk is existing rows — all null in the seed, so the
ALTER should apply cleanly. **Confirm you want the constraint.**

### Q13 — Existing §15 open questions that block parts of this plan

Already in the spec's own Open questions list, now with schema consequences:

| §15 item                                                                                        | Blocks                                                                                                                                                                                       |
| ----------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Q2 QR payments** — static QR with manual verification, gateway QR Ph (auto-confirm), or both? | Whether `manual_qr` and `qrph` are both needed in `PAYMENT_METHODS`, and whether the manual-verification columns (`txn_ref`, `receipt_path`, `reject_reason`, `verified_by`) are dead weight |
| **Q3 PayPal** — enabled on the PayMongo account?                                                | Whether `PAYMENT_METHODS` needs a `paypal` value                                                                                                                                             |
| **Q5 Cancellation policy** — window and refund rules per tour                                   | Q5 above (whether `free_cancel_hours` is frozen into `price_snapshot`)                                                                                                                       |
| **Q1 Assignment deadline**                                                                      | Now partly settled by the Q7 answer, but the 48-hour reading is still open                                                                                                                   |

---

## Self-review

Run against the spec with fresh eyes, as the writing-plans skill requires.

**1. Spec coverage.** All 16 missing §10 tables have a task: `users` (1), `audit_log` (2), `vans`
(3), `drivers` + `driver_leaves` (4), `coupons` (5), `tour_date_slots` + `payment_events` (6),
`sessions` (7), `bookings` (8), `booking_addons` + `booking_notes` + `coupon_redemptions` (10),
`trip_checkpoints` + `review_helpful_votes` (11), `payments` (12). That is 16. Both §10 index lists
(`bookings` ×3, `payments` ×2) are transcribed into Tasks 8 and 12.

Three further tasks carry owner decisions rather than tables: **19** (deposit rounding, Q4), **20**
(the Express error handler), and the CHECK constraint folded into **5** (Q6). Twenty tasks total.

**Deliberate gaps, stated rather than hidden:**

- The **pricing, capacity and holds services** (§5) are not here. This plan builds the tables they
  need and stops. They are Week 3. Q4 and Q7 are now answered, so the remaining blocker for the
  capacity service is Q14 (what serialises the cross-tour fleet check).
- The **`fleet_date_slots` table** that the Q7 answer implies is **not built** — it is a 17th table
  beyond this plan's scope and waits on Q14. Task 6 carries the warning and the proposed shape.
- The **expired-hold cron** (§5) is not here — no `jobs/` directory exists yet.
- **Notifications** (§11) are not here; no table is required for them.
- **Checkout, portals and admin screens** are not here by design (see Scope check).
- `requireRole` (Task 17) defines the gate and tests it against a harness; wiring it onto real admin
  procedures happens when those procedures exist, in Weeks 5–7.

**2. Placeholder scan.** No "TBD", no "add error handling", no "similar to Task N". Tasks 14, 15 and
16 give implementation _shape_ plus full test code rather than complete function bodies — Task 14
and 16 in particular depend on Q4 (deposit rounding) and on PayMongo's live API response shape,
which should be read from their current docs at implementation time rather than frozen into a plan
written today. That is a deliberate, named limit, not a placeholder; every test in those tasks is
complete and runnable.

**3. Type consistency.** Checked across tasks: `AdminRole` (1) is used by 17. `writeAudit(tx, entry)`
(2) is called in 14 with the same signature. `PAYMENT_PROVIDERS` (6) types `payments.provider` (12)
and `ProviderName` (13). `BookingStatus` (8) is the return type in 14. `bookingRefSchema` (8) is
validated against `generateBookingRef()` (9) — same alphabet, same length, and Task 9 asserts the
agreement rather than assuming it. `Transaction` (2) is used by 9 and 14. `PaymentProvider` (13) is
implemented by 13's stub and 16's PayMongo. No name appears in two spellings.

**One inconsistency found and fixed during review:** Task 9's alphabet is 30 characters
(`ABCDEFGHJKMNPQRSTVWXYZ23456789`), not the 32 an earlier draft claimed, so the keyspace is 30⁶ ≈
729 million, not 1.07 billion. The figure in Task 9's comment is the corrected one.

---

## What happens after approval

1. Answer the open questions above — Q7 is blocking, Q4 and Q6 affect money, the rest affect shape.
2. Execute with `superpowers:subagent-driven-development`, one task per subagent, reviewing between.
3. Apply migrations **only** against `rg_travel` locally. The server database gets them in a
   separate, dedicated deployment prompt — and after any schema change, the user must be reminded to
   apply the migration on the server (CLAUDE.md Workflow).
4. Expect roughly 120–160 new tests from the 18 tasks, every one proven able to fail.
