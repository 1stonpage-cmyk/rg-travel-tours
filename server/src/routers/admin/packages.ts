/**
 * `admin.packages.*` and `admin.inquiries.*` — the multi-day package catalog's
 * editing surface and the enquiry queue it feeds (Week 7 plan, Task 13 — 7C;
 * BUILD_SPEC §9 "Packages: multi-day packages and their inquiries").
 *
 * ## One area, owner and dispatcher
 *
 * Every procedure in this file is `adminProcedure('packagesInquiries')` — the
 * `ROLE_MATRIX` row added by **owner decision 2026-10-23 (Q3, option c)**. An
 * enquiry is operational work that somebody has to answer the same day, and a
 * dispatcher already reads guest names, emails and phone numbers under
 * `bookingsView`, so this adds no class of personal data they cannot already
 * see. **Finance is refused** — by the gate, not by a resolver finding nothing
 * to do: an enquiry carries no money.
 *
 * Packages and enquiries share the file because they share the gate and the
 * screen: a package enquiry is about a package, and editing one while
 * answering the other is one person's afternoon.
 *
 * **The newsletter export is NOT here.** It is `admin.newsletter.export`,
 * gated `usersSettings` (owner only) — same decision, same screen, a
 * different area. See `./newsletter.ts`.
 *
 * ## This file does not write `inquiries`
 *
 * `inquiries` rows are created by the PUBLIC `inquiries.create` mutation, which
 * already exists and is already rate-limited in `app.ts`. Nothing here inserts
 * one and nothing here edits a guest's words: an admin moves the STATUS and
 * that is all. An editable `message` would make every enquiry on the screen
 * unfalsifiable, and an admin-composed enquiry would be a guest's question
 * nobody asked.
 *
 * ## There is deliberately no delete mutation
 *
 * A package is retired through `setActive(false)` (CLAUDE.md, "Soft deletes"),
 * which hides it from `packages.list`, makes `packages.bySlug` answer
 * `NOT_FOUND`, and changes nothing else — the `inquiries` rows that point at it
 * stay exactly where they are, which is why `inquiries.package_id` is a
 * RESTRICT foreign key and why a hard delete would be refused by MySQL even if
 * somebody wrote one. There is no delete for an enquiry either: a guest really
 * did ask, and `closed` is what "we are done with this" looks like.
 *
 * One transaction per mutation, opened here, with the audit write inside it —
 * an audit row that survives a rollback claims a change nobody made.
 */
import { TRPCError } from '@trpc/server';
import {
  inquiryStatusInput,
  packageActiveInput,
  packageCreateInput,
  packageUpdateInput,
  type InquiryAdminRow,
  type PackageAdminRow,
} from '@rg/shared';
import { asc, desc, eq, sql } from 'drizzle-orm';
import { getDb } from '../../db/client';
import { isDuplicateKeyError } from '../../db/duplicate-key';
import { inquiries, packages } from '../../db/schema';
import { writeAudit } from '../../services/audit';
import { adminProcedure, router } from '../../trpc';

/** The one message for a slug another package already holds. */
const DUPLICATE_SLUG_MESSAGE = 'A package with that slug already exists.';

/** The one message for an id that is not a package. */
const PACKAGE_NOT_FOUND_MESSAGE = 'No package with that id.';

/** The one message for an id that is not an enquiry. */
const INQUIRY_NOT_FOUND_MESSAGE = 'No enquiry with that id.';

/** `audit_log.entity`, matching each table's own name. */
const PACKAGE_ENTITY = 'packages';
const INQUIRY_ENTITY = 'inquiries';

/**
 * `packages.highlights` is a `json` column, so Drizzle types it `unknown` —
 * the rows predate this editing surface and a hand-written INSERT could have
 * put anything in them. Anything that is not an array of strings reads back as
 * null rather than being forced into the payload's type: the editing screen
 * then shows an empty list, and the next save replaces the malformed value
 * with a well-formed one. (The same treatment `admin.tours.detail` gives
 * `tours.inclusions`.)
 */
function asStringArray(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  return value.every((entry) => typeof entry === 'string') ? (value as string[]) : null;
}

/**
 * The editable columns of a package, from a validated input.
 *
 * Shared by `create` and `update` so the two cannot drift about which columns
 * a save states. `isActive` is absent on purpose — `setActive` owns it — and
 * the inputs are `.strict()`, so it cannot be posted either.
 */
function packageColumns(input: {
  slug: string;
  title: string;
  days: number;
  oldPriceCentavos: number | null;
  newPriceCentavos: number;
  description: string | null;
  imagePath: string | null;
  imageAlt: string | null;
  highlights: string[] | null;
  sortOrder: number;
  seoTitle: string | null;
  seoDescription: string | null;
  ogImage: string | null;
}) {
  return {
    slug: input.slug,
    title: input.title,
    days: input.days,
    oldPriceCentavos: input.oldPriceCentavos,
    newPriceCentavos: input.newPriceCentavos,
    description: input.description,
    imagePath: input.imagePath,
    imageAlt: input.imageAlt,
    highlights: input.highlights,
    sortOrder: input.sortOrder,
    seoTitle: input.seoTitle,
    seoDescription: input.seoDescription,
    ogImage: input.ogImage,
  };
}

/**
 * The audit payload for a save: the identifiers and the money.
 *
 * Both prices in full, because they are what a guest is quoted and what the
 * struck-through "was" claims; the prose (`description`, the SEO fields, the
 * highlights) is not, because a dump of the whole package would bury them.
 * Nothing sensitive can reach it — a package row holds no personal datum.
 */
function auditDataFor(columns: ReturnType<typeof packageColumns>) {
  return {
    slug: columns.slug,
    title: columns.title,
    days: columns.days,
    oldPriceCentavos: columns.oldPriceCentavos,
    newPriceCentavos: columns.newPriceCentavos,
    sortOrder: columns.sortOrder,
  };
}

/**
 * Turns a duplicate-slug driver error into the refusal a screen can show.
 *
 * `packages.slug` is UNIQUE, so the race is real rather than theoretical: two
 * admins saving the same slug at once both pass a read-then-write check and one
 * of them gets `ER_DUP_ENTRY`. Catching the constraint rather than checking
 * first is what makes this correct under concurrency — and translating it is
 * what stops mysql2's own sentence, which quotes the submitted value, reaching
 * a browser.
 */
function rethrowAsSlugConflict(error: unknown): never {
  if (isDuplicateKeyError(error)) {
    throw new TRPCError({ code: 'CONFLICT', message: DUPLICATE_SLUG_MESSAGE });
  }
  throw error;
}

export const adminPackagesRouter = router({
  /**
   * Every package, **inactive ones included** — the admin list is the only
   * place a retired package is visible, and therefore the only place it can be
   * switched back on.
   *
   * One query, not one per package: the packages `LEFT JOIN`ed to their
   * enquiries with `COUNT()` aggregated per package. A `LEFT JOIN` so a package
   * nobody has asked about is still listed, with `inquiryCount: 0`.
   *
   * `groupBy(packages.id)` alone, where `admin.tours.list` lists every selected
   * column. The difference is that this `SELECT` reads `description` (`text`)
   * and `highlights` (`json`), and grouping those to count a child table is a
   * worse query than relying on what ONLY_FULL_GROUP_BY already allows: every
   * non-aggregate column here belongs to `packages` and is functionally
   * dependent on its PRIMARY KEY, which MySQL has detected since 5.7. Measured
   * against this database before being written, not assumed.
   *
   * A correlated `(select count(*) …)` was tried first and was WRONG: with one
   * table in the `FROM`, Drizzle renders column references unqualified, so the
   * subquery's `where package_id = id` bound `id` to `inquiries.id` and every
   * count came back 0. The join qualifies both sides.
   */
  list: adminProcedure('packagesInquiries').query(async (): Promise<PackageAdminRow[]> => {
    const rows = await getDb()
      .select({
        id: packages.id,
        slug: packages.slug,
        title: packages.title,
        days: packages.days,
        oldPriceCentavos: packages.oldPriceCentavos,
        newPriceCentavos: packages.newPriceCentavos,
        description: packages.description,
        imagePath: packages.imagePath,
        imageAlt: packages.imageAlt,
        highlights: packages.highlights,
        sortOrder: packages.sortOrder,
        seoTitle: packages.seoTitle,
        seoDescription: packages.seoDescription,
        ogImage: packages.ogImage,
        isActive: packages.isActive,
        inquiryCount: sql<string>`count(${inquiries.id})`,
      })
      .from(packages)
      .leftJoin(inquiries, eq(inquiries.packageId, packages.id))
      .groupBy(packages.id)
      // The order the public list uses, so the screen and the site agree.
      .orderBy(asc(packages.sortOrder), asc(packages.id));

    return rows.map((row) => ({
      id: row.id,
      slug: row.slug,
      title: row.title,
      days: row.days,
      oldPriceCentavos: row.oldPriceCentavos,
      newPriceCentavos: row.newPriceCentavos,
      description: row.description,
      imagePath: row.imagePath,
      imageAlt: row.imageAlt,
      highlights: asStringArray(row.highlights),
      sortOrder: row.sortOrder,
      seoTitle: row.seoTitle,
      seoDescription: row.seoDescription,
      ogImage: row.ogImage,
      isActive: row.isActive,
      // MySQL returns COUNT() as a string through mysql2.
      inquiryCount: Number(row.inquiryCount),
    }));
  }),

  create: adminProcedure('packagesInquiries')
    .input(packageCreateInput)
    .mutation(async ({ input, ctx }) => {
      const columns = packageColumns(input);
      try {
        const id = await getDb().transaction(async (tx) => {
          const [result] = await tx.insert(packages).values(columns);
          await writeAudit(tx, {
            actorType: 'user',
            actorId: ctx.session.subjectId,
            action: 'package.created',
            entity: PACKAGE_ENTITY,
            entityId: result.insertId,
            data: auditDataFor(columns),
          });
          return result.insertId;
        });
        return { id };
      } catch (error) {
        rethrowAsSlugConflict(error);
      }
    }),

  /**
   * A full replacement of the editable columns, never a patch — see
   * `shared/src/packages-admin.ts` for why an omitted `oldPriceCentavos` has
   * no safe meaning.
   *
   * It does not touch `is_active`: an edit is not a way to switch a retired
   * package back on.
   */
  update: adminProcedure('packagesInquiries')
    .input(packageUpdateInput)
    .mutation(async ({ input, ctx }) => {
      const columns = packageColumns(input);
      try {
        await getDb().transaction(async (tx) => {
          const [result] = await tx.update(packages).set(columns).where(eq(packages.id, input.id));
          /*
           * `affectedRows === 0` is an exact "no such package" here: mysql2
           * sets `CLIENT_FOUND_ROWS` in its default client flags and
           * `db/client.ts` turns it off nowhere, so `affectedRows` is the
           * MATCHED count — a save that rewrites a package with the values it
           * already holds still reports 1. (See `db/client.ts`'s header; this
           * codebase has believed the opposite twice.)
           */
          if (result.affectedRows === 0) {
            throw new TRPCError({ code: 'NOT_FOUND', message: PACKAGE_NOT_FOUND_MESSAGE });
          }
          await writeAudit(tx, {
            actorType: 'user',
            actorId: ctx.session.subjectId,
            action: 'package.updated',
            entity: PACKAGE_ENTITY,
            entityId: input.id,
            data: auditDataFor(columns),
          });
        });
        return { ok: true as const };
      } catch (error) {
        rethrowAsSlugConflict(error);
      }
    }),

  /**
   * The soft delete, and the only writer of `packages.is_active`.
   *
   * Deactivating hides the package from `packages.list` and makes
   * `packages.bySlug` answer `NOT_FOUND`, and changes nothing else: its prices,
   * its image and every `inquiries` row pointing at it stay where they are.
   * Reactivating puts it back.
   *
   * Two dotted audit actions rather than one `package.active_set` with a flag
   * in the payload — "who retired this package" is the question an owner asks,
   * and it should not need a payload to answer. The same shape
   * `admin.tours.setActive` and `admin.coupons.setActive` use.
   */
  setActive: adminProcedure('packagesInquiries')
    .input(packageActiveInput)
    .mutation(async ({ input, ctx }) => {
      await getDb().transaction(async (tx) => {
        const [row] = await tx
          .select({ slug: packages.slug, isActive: packages.isActive })
          .from(packages)
          .where(eq(packages.id, input.id))
          // The row lock: two admins clicking at once must not both write and
          // must not both audit a decision.
          .for('update')
          .limit(1);
        if (!row) {
          throw new TRPCError({ code: 'NOT_FOUND', message: PACKAGE_NOT_FOUND_MESSAGE });
        }

        /*
         * Already where it is being asked to go: write nothing, log nothing
         * (7N item 6 — the identical fix `admin.staffUsers.setActive` took in
         * the same commit, and the reasoning is that procedure's).
         *
         * The `UPDATE` and the audit row were both unconditional, so a second
         * click wrote a `package.deactivated` row claiming a status change
         * that did not happen. It still answers `{ ok: true }`: the state the
         * caller asked for is the state that holds.
         *
         * Under the row lock the `.for('update')` above already took, which
         * is what the lock's own comment is for — two admins clicking at once
         * cannot both read "it differs" and both audit.
         */
        if (row.isActive === input.isActive) return;

        await tx
          .update(packages)
          .set({ isActive: input.isActive })
          .where(eq(packages.id, input.id));

        await writeAudit(tx, {
          actorType: 'user',
          actorId: ctx.session.subjectId,
          action: input.isActive ? 'package.reactivated' : 'package.deactivated',
          entity: PACKAGE_ENTITY,
          entityId: input.id,
          data: { slug: row.slug, isActive: input.isActive },
        });
      });
      return { ok: true as const };
    }),
});

export const adminInquiriesRouter = router({
  /**
   * Every enquiry, **newest first** — that is the queue: an office opens this
   * screen to find what came in today.
   *
   * `LEFT JOIN packages`, because `inquiries.package_id` is nullable: a general
   * contact-form enquiry has no package, and an inner join would drop exactly
   * the rows a contact form produces. The title is joined rather than left to
   * the client to look up, so "enquiry about (nothing)" cannot appear on the
   * screen — the reason that column was made a real foreign key.
   *
   * It returns the guest's name, email, phone and message, which is the whole
   * point of the screen and why §9 gates it on owner and dispatcher and leaves
   * finance out (RA 10173: admin-only access to personal data, and only the
   * roles whose work needs it).
   *
   * No input and no status filter, the same shape `admin.reviews.queue` uses:
   * the screen wants all four states at once to show its counts, and a filter
   * the client could pass would be one more thing to check against the gate.
   * The client narrows what it renders. **Known limit:** there is no page, so a
   * table that has grown for years is returned whole; pagination was not in
   * this task's plan and would want a `limit`/`cursor` input of its own.
   */
  list: adminProcedure('packagesInquiries').query(async (): Promise<InquiryAdminRow[]> => {
    const rows = await getDb()
      .select({
        id: inquiries.id,
        type: inquiries.type,
        status: inquiries.status,
        packageId: inquiries.packageId,
        packageTitle: packages.title,
        name: inquiries.name,
        email: inquiries.email,
        phone: inquiries.phone,
        message: inquiries.message,
        createdAt: inquiries.createdAt,
      })
      .from(inquiries)
      .leftJoin(packages, eq(inquiries.packageId, packages.id))
      // `id` after `created_at`: `created_at` is a `DATETIME` with second
      // precision, so two enquiries can share an instant and a queue needs a
      // total order.
      .orderBy(desc(inquiries.createdAt), desc(inquiries.id));

    return rows.map((row) => ({
      id: row.id,
      type: row.type,
      status: row.status,
      packageId: row.packageId,
      packageTitle: row.packageTitle,
      name: row.name,
      email: row.email,
      phone: row.phone,
      message: row.message,
      // UTC instants out as UTC instants: the SCREEN converts to Manila.
      createdAt: row.createdAt.toISOString(),
    }));
  }),

  /**
   * Moves one enquiry through `new` → `read` → `replied` → `closed`, and back.
   *
   * **All four statuses are settable, including `new`** — unlike
   * `admin.reviews.setStatus`, which refuses `pending`. The difference is what
   * the first state MEANS. A review's `pending` is "no human has looked at
   * this", which an admin cannot truthfully re-assert once they have. An
   * enquiry's `new` is "this still needs an answer", which an office can
   * legitimately decide again — a reply bounced, a guest wrote back, somebody
   * closed the wrong row — and it is the only way the "waiting" count on the
   * screen can be put right.
   *
   * ONE audit action with both statuses in the payload, rather than four dotted
   * verbs: with two states a dotted pair answers "who published this" without a
   * payload, but with four a verb per transition would be twelve names for one
   * event. `{from, to}` is the readable form.
   *
   * **The payload names no personal data.** The guest's name, email, phone and
   * message are on the enquiry row and on the screen that is allowed to show
   * them; the log is the record of who acted, not a second copy of a guest's
   * question in a table every admin can read (RA 10173).
   */
  setStatus: adminProcedure('packagesInquiries')
    .input(inquiryStatusInput)
    .mutation(async ({ input, ctx }) => {
      await getDb().transaction(async (tx) => {
        const [row] = await tx
          .select({ status: inquiries.status })
          .from(inquiries)
          .where(eq(inquiries.id, input.id))
          .for('update')
          .limit(1);
        if (!row) {
          throw new TRPCError({ code: 'NOT_FOUND', message: INQUIRY_NOT_FOUND_MESSAGE });
        }

        await tx.update(inquiries).set({ status: input.status }).where(eq(inquiries.id, input.id));

        await writeAudit(tx, {
          actorType: 'user',
          actorId: ctx.session.subjectId,
          action: 'inquiry.status_changed',
          entity: INQUIRY_ENTITY,
          entityId: input.id,
          data: { from: row.status, to: input.status },
        });
      });
      return { ok: true as const };
    }),
});
