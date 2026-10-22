/**
 * Week 6.5, Task 6 (owner decision D6, 2026-10-16) — office notes a driver
 * may not read, and the first writer `booking_notes` has ever had.
 *
 * **The problem this closes.** `driver.trip` used to return every row of
 * `booking_notes` for the trip, and nothing could WRITE one either, so the
 * office had no way to record "the guest disputed the price, do not discuss
 * it" without the driver reading it at the pickup. Now each note carries a
 * `visible_to_driver` flag, `admin.bookings.addNote` makes the office state
 * it per note, and the driver's read filters on it in SQL.
 *
 * The properties, and which test owns each:
 *
 *  1. **A private note NEVER reaches the driver** — not in `officeNotes` and
 *     not anywhere in the serialised payload (first test).
 *  2. **A note written by anything that forgets the flag is private**, and
 *     that is a property of the DATABASE, not of Drizzle's opinion: the
 *     default test inserts with raw SQL and reads `information_schema`.
 *  3. **The flag is a required decision** on the mutation — omitting it is
 *     refused rather than defaulted either way.
 *  4. **The audit row exists, is findable on the booking's own trail, and
 *     does not duplicate the note text.**
 *  5. **Role gate: `bookingsView`** (§9: "Bookings: view, notes"), so owner,
 *     dispatcher AND finance may write. The refusals are a driver session
 *     and an anonymous one — NOT a dispatcher, who is allowed.
 *
 * Every row this file creates is deleted in `afterAll`, in FK order.
 * `booking_notes` is not one of the leak detector's tables, so a leak here
 * would not fail the run — it would quietly skew the next suite to count
 * notes, which is why `noteCount()` is taken as a before/after delta.
 */
import { afterAll, afterEach, beforeAll, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { getDb, getPool } from '../db/client';
import {
  auditLog,
  bookingNotes,
  bookings,
  destinations,
  drivers,
  tours,
  users,
} from '../db/schema';
import { driverTripDetail } from '../routers/public/driver';
import { appRouter } from '../routers/_app';
import { generateBookingRef } from '../services/booking-ref';
import { driverCaller, staffContext, testContext } from './helpers/ctx';
import { describeWithDb } from './helpers/db';

const unique = () => `${Math.floor(Math.random() * 1e9)}_${Date.now()}`;

const created = {
  bookingIds: [] as number[],
  tourIds: [] as number[],
  destIds: [] as number[],
  driverIds: [] as number[],
  userIds: [] as number[],
};

let ownerUserId = 0;
let dispatcherUserId = 0;
let financeUserId = 0;
let driverId = 0;
let bookingId = 0;
let bookingRef = '';

async function makeStaff(role: 'owner' | 'dispatcher' | 'finance') {
  const suffix = unique();
  const [row] = await getDb()
    .insert(users)
    .values({
      name: `Notes ${role} ${suffix}`,
      email: `bknotes_${role}_${suffix}@example.test`,
      passwordHash: '__bknotes_not_a_hash__',
      role,
      isActive: true,
    });
  created.userIds.push(row.insertId);
  return row.insertId;
}

const OWNER = () => appRouter.createCaller(staffContext(ownerUserId, 'owner') as never);
const DISPATCHER = () =>
  appRouter.createCaller(staffContext(dispatcherUserId, 'dispatcher') as never);
const FINANCE = () => appRouter.createCaller(staffContext(financeUserId, 'finance') as never);

type NoteInput = { bookingId: number; note: string; visibleToDriver: boolean };
const addNote = (input: NoteInput, caller = OWNER()) => caller.admin.bookings.addNote(input);

async function noteCount(): Promise<number> {
  const [rows] = await getPool().query('SELECT COUNT(*) n FROM booking_notes');
  return Number((rows as Array<{ n: number }>)[0]?.n ?? -1);
}

async function noteRow(id: number) {
  const [row] = await getDb().select().from(bookingNotes).where(eq(bookingNotes.id, id));
  return row!;
}

async function auditRowsFor(entity: string, entityId: number) {
  return getDb()
    .select()
    .from(auditLog)
    .where(and(eq(auditLog.entity, entity), eq(auditLog.entityId, entityId)));
}

describeWithDb('booking notes — visibility to the driver', () => {
  beforeAll(async () => {
    ownerUserId = await makeStaff('owner');
    dispatcherUserId = await makeStaff('dispatcher');
    financeUserId = await makeStaff('finance');

    const db = getDb();
    const slug = `__bknotes__${unique()}`;
    const [destination] = await db.insert(destinations).values({ name: slug, slug });
    created.destIds.push(destination.insertId);
    const [tour] = await db
      .insert(tours)
      .values({ slug, title: `Notes Tour ${slug}`, destinationId: destination.insertId });
    created.tourIds.push(tour.insertId);

    const suffix = unique();
    const [driver] = await db.insert(drivers).values({
      name: `Notes Driver ${suffix}`,
      code: `BN${suffix}`.slice(0, 20),
      phone: '09170000002',
      pinHash: '__bknotes_not_a_pin_hash__',
      isActive: true,
    });
    created.driverIds.push(driver.insertId);
    driverId = driver.insertId;

    bookingRef = generateBookingRef();
    const [booking] = await db.insert(bookings).values({
      ref: bookingRef,
      tourId: tour.insertId,
      tourDate: new Date('2099-04-10T00:00:00Z'),
      pax: 2,
      leadName: 'Notes Lead Guest',
      leadEmail: `bknotes_${suffix}@example.test`,
      leadPhone: '09171112222',
      status: 'assigned',
      payMode: 'full',
      priceSnapshot: {
        tier: { tierId: 1, minPax: 1, maxPax: 12, pricePerPersonCentavos: 100_000 },
        addons: [],
        coupon: null,
        depositPercent: 30,
        freeCancelHours: 48,
        subtotalCentavos: 200_000,
        discountCentavos: 0,
        totalCentavos: 200_000,
      },
      subtotalCentavos: 200_000,
      totalCentavos: 200_000,
      amountPaidCentavos: 200_000,
      driverId,
    });
    created.bookingIds.push(booking.insertId);
    bookingId = booking.insertId;
  }, 30_000);

  /** Notes only: the booking, driver and staff are shared by every test. */
  afterEach(async () => {
    const pool = getPool();
    for (const id of created.bookingIds) {
      await pool.query('DELETE FROM booking_notes WHERE booking_id = ?', [id]);
    }
  });

  afterAll(async () => {
    const pool = getPool();
    for (const id of created.bookingIds) {
      await pool.query('DELETE FROM booking_notes WHERE booking_id = ?', [id]);
      await pool.query("DELETE FROM audit_log WHERE entity = 'bookings' AND entity_id = ?", [id]);
      await pool.query('DELETE FROM bookings WHERE id = ?', [id]);
    }
    for (const id of created.tourIds) await pool.query('DELETE FROM tours WHERE id = ?', [id]);
    for (const id of created.destIds) {
      await pool.query('DELETE FROM destinations WHERE id = ?', [id]);
    }
    for (const id of created.driverIds) await pool.query('DELETE FROM drivers WHERE id = ?', [id]);
    for (const id of created.userIds) await pool.query('DELETE FROM users WHERE id = ?', [id]);
  });

  /* ---------------------------------------------------------------- *
   * What the driver can read.
   * ---------------------------------------------------------------- */

  it('an unflagged note NEVER reaches the driver API', async () => {
    await addNote(
      { bookingId, note: 'Guest disputed the price — do not discuss.', visibleToDriver: false },
      OWNER(),
    );
    await addNote({ bookingId, note: 'Waiting at the second gate.', visibleToDriver: true });

    const detail = await driverTripDetail(driverId, bookingId);
    expect(detail.officeNotes).toEqual(['Waiting at the second gate.']);
    // Not merely absent from the array — absent from the whole payload, in
    // case a later field carries notes too.
    expect(JSON.stringify(detail)).not.toMatch(/disputed the price/);

    // And through the mounted procedure, which is what a phone calls.
    const viaRouter = await driverCaller(driverId).driver.trip({ bookingId });
    expect(viaRouter.officeNotes).toEqual(['Waiting at the second gate.']);
    expect(JSON.stringify(viaRouter)).not.toMatch(/disputed the price/);
  });

  it('keeps the driver payload shape: a list of strings, with no hint that private notes exist', async () => {
    await addNote({ bookingId, note: 'Private one.', visibleToDriver: false });
    await addNote({ bookingId, note: 'Private two.', visibleToDriver: false });

    const detail = await driverTripDetail(driverId, bookingId);
    // Two private notes and an EMPTY list: "there are 2 notes you cannot
    // read" would invite the phone call the flag exists to avoid.
    expect(detail.officeNotes).toEqual([]);
    expect(Object.keys(detail)).not.toContain('hiddenNotes');
    expect(JSON.stringify(detail)).not.toMatch(/Private (one|two)/);
  });

  it('defaults to invisible, so a note written by anything that forgets the flag is private', async () => {
    // A raw insert — a migration, a seed, a hand-written UPDATE at 2am.
    // `created_at` is supplied because Drizzle's `$defaultFn` fills it, not
    // MySQL — it says nothing about the flag, which is the column left out.
    await getPool().query(
      'INSERT INTO booking_notes (booking_id, user_id, note, created_at) VALUES (?, ?, ?, UTC_TIMESTAMP())',
      [bookingId, ownerUserId, 'Written with no flag at all.'],
    );

    const detail = await driverTripDetail(driverId, bookingId);
    expect(detail.officeNotes).toEqual([]);

    const adminView = await OWNER().admin.bookings.detail({ ref: bookingRef });
    expect(adminView.notes).toEqual([
      expect.objectContaining({ note: 'Written with no flag at all.', visibleToDriver: false }),
    ]);
  });

  it('the column is NOT NULL DEFAULT 0 in the database, not only in Drizzle', async () => {
    const [rows] = await getPool().query(
      `SELECT IS_NULLABLE, COLUMN_DEFAULT, COLUMN_TYPE FROM information_schema.COLUMNS
        WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'booking_notes' AND COLUMN_NAME = 'visible_to_driver'`,
    );
    // Observed on MySQL 8.0.46: Drizzle's `boolean()` is `tinyint(1)`, and
    // information_schema reports its default as the STRING '0'.
    expect((rows as unknown[])[0]).toMatchObject({
      IS_NULLABLE: 'NO',
      COLUMN_DEFAULT: '0',
      COLUMN_TYPE: 'tinyint(1)',
    });
  });

  /* ---------------------------------------------------------------- *
   * What the office can read.
   * ---------------------------------------------------------------- */

  it('the admin detail shows every note WITH its visibility, newest first', async () => {
    await addNote({ bookingId, note: 'Private.', visibleToDriver: false });
    await addNote({ bookingId, note: 'Shared.', visibleToDriver: true });

    const detail = await OWNER().admin.bookings.detail({ ref: bookingRef });
    expect(detail.notes).toEqual([
      expect.objectContaining({ note: 'Shared.', visibleToDriver: true }),
      expect.objectContaining({ note: 'Private.', visibleToDriver: false }),
    ]);
  });

  /* ---------------------------------------------------------------- *
   * The writer.
   * ---------------------------------------------------------------- */

  it('records who wrote the note, and audits it without copying the text', async () => {
    const { id } = await addNote({ bookingId, note: 'A note.', visibleToDriver: true }, FINANCE());
    const row = await noteRow(id);
    expect(row.userId).toBe(financeUserId);
    expect(row.bookingId).toBe(bookingId);
    expect(row.visibleToDriver).toBe(true);

    const audit = (await auditRowsFor('bookings', bookingId)).find(
      (r) => r.action === 'booking.note_added' && (r.data as { noteId?: number }).noteId === id,
    );
    expect(audit, 'no booking.note_added row on entity "bookings"').toBeDefined();
    expect(audit!.actorType).toBe('user');
    expect(audit!.actorId).toBe(financeUserId);
    expect(audit!.data).toMatchObject({ noteId: id, visibleToDriver: true });
    // The note TEXT is not duplicated into the audit payload: it is already
    // stored, and audit rows are exported in reports.
    expect(JSON.stringify(audit!.data)).not.toMatch(/A note\./);

    // And it is on the trail the booking screen actually reads.
    const detail = await OWNER().admin.bookings.detail({ ref: bookingRef });
    expect(detail.audit.map((entry) => entry.action)).toContain('booking.note_added');
  });

  it('trims the note it stores', async () => {
    const { id } = await addNote({ bookingId, note: '  Padded.  ', visibleToDriver: false });
    expect((await noteRow(id)).note).toBe('Padded.');
  });

  /** §9 "Bookings: view, notes" is all three admin roles, a dispatcher included. */
  it('lets owner, dispatcher and finance each write a note', async () => {
    for (const [caller, userId] of [
      [OWNER(), ownerUserId],
      [DISPATCHER(), dispatcherUserId],
      [FINANCE(), financeUserId],
    ] as const) {
      const { id } = await addNote(
        { bookingId, note: `By ${userId}.`, visibleToDriver: false },
        caller,
      );
      expect((await noteRow(id)).userId).toBe(userId);
    }
  });

  it('takes the author from the session, never from the payload', async () => {
    await expect(
      OWNER().admin.bookings.addNote({
        bookingId,
        note: 'Forged author.',
        visibleToDriver: true,
        userId: financeUserId,
      } as never),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(await noteCount()).toBe(0);
  });

  it('refuses an empty note and a whitespace note, writing nothing', async () => {
    for (const note of ['', '   ']) {
      await expect(addNote({ bookingId, note, visibleToDriver: true })).rejects.toMatchObject({
        code: 'BAD_REQUEST',
      });
    }
    expect(await noteCount()).toBe(0);
  });

  it('refuses a note over the length limit', async () => {
    await expect(
      addNote({ bookingId, note: 'x'.repeat(2001), visibleToDriver: true }),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(await noteCount()).toBe(0);
  });

  /**
   * The caller must STATE the decision. A schema that defaulted the flag —
   * either way — would turn a forgotten field into a choice nobody made.
   */
  it('refuses a call that does not say whether the driver may read it', async () => {
    await expect(
      OWNER().admin.bookings.addNote({ bookingId, note: 'Undecided.' } as never),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(await noteCount()).toBe(0);
  });

  it('refuses a driver session and an anonymous one, writing nothing', async () => {
    await expect(
      driverCaller(driverId).admin.bookings.addNote({
        bookingId,
        note: 'No.',
        visibleToDriver: true,
      }),
    ).rejects.toMatchObject({ code: 'UNAUTHORIZED' });

    const anonymous = appRouter.createCaller(testContext() as never);
    await expect(
      anonymous.admin.bookings.addNote({ bookingId, note: 'No.', visibleToDriver: true }),
    ).rejects.toMatchObject({ code: 'UNAUTHORIZED' });

    expect(await noteCount()).toBe(0);
  });

  it('refuses a note on a booking that does not exist, writing nothing', async () => {
    const before = await noteCount();
    const auditBefore = (await auditRowsFor('bookings', 9_999_999)).length;
    await expect(
      addNote({ bookingId: 9_999_999, note: 'x', visibleToDriver: true }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(await noteCount()).toBe(before);
    expect((await auditRowsFor('bookings', 9_999_999)).length).toBe(auditBefore);
  });
});
