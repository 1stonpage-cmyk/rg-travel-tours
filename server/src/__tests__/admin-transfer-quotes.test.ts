/**
 * Transfers-launch plan, Task T19 — `admin.transferQuotes.convert` and the
 * new `transferQuoting` ROLE_MATRIX area (owner answer 4; §6 steps 2–3).
 *
 * **The load-bearing assertion is the role boundary**, per the plan's own
 * "dual-trigger for maximum scrutiny" framing (money AND a new role
 * boundary): owner and finance convert; **dispatcher is refused by the GATE,
 * against the REAL mounted procedure**, not a fixture — `role-isolation.test.ts`'s
 * generated 39-case matrix already proves the gate in the abstract; this file
 * proves it end to end, the way the plan's own text asks Task T19 to.
 *
 * Everything else here is the fence around that: the inquiry pre-checks (not
 * found, wrong type, already converted, a malformed row with no route
 * description), the staff-entered fields that exist because an inquiry
 * column is nullable (`leadPhone`, `pax`), the new
 * `custom_one_way_needs_duration` plumbing, the dedicated
 * `transfer.custom_quote_converted` audit row, and the compare-and-swap race
 * this module's own header describes.
 *
 * **Teardown.** `inquiries` is not in the leak detector's `LEAK_TABLES`, so
 * every inquiry this file makes is removed by id in `afterEach`/`afterAll`.
 * Bookings, their transfer details and audit rows follow
 * `transfer-create-booking.test.ts`'s own removal order; vans and drivers are
 * deleted the same way, because they are not date-scoped and this file's
 * capacity counts depend on an otherwise-empty fleet, proven in `beforeEach`
 * rather than assumed.
 */
import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import type { TransferQuoteConvertInput } from '@rg/shared';
import { ROLE_MATRIX } from '../middleware/require-role';
import { appRouter } from '../routers/_app';
import { getDb, getPool } from '../db/client';
import {
  auditLog,
  bookingTransferDetails,
  bookings,
  drivers,
  inquiries,
  users,
  vans,
  vehicleTypes,
} from '../db/schema';
import { resetTransportForTests, setTransportForTests } from '../services/notify';
import {
  convertTransferQuote,
  TransferQuoteConvertRaceError,
  type ConvertTransferQuoteInput,
} from '../services/transfers/convert-quote';
import { staffContext, testContext } from './helpers/ctx';
import { describeWithDb } from './helpers/db';

/**
 * Captures what `sendQuoteReadyNotice` (Task T21) sends through the REAL
 * router, the same way `phase1-walkthrough.test.ts` captures mail. Only
 * `admin.transferQuotes.convert` calls it — `convertTransferQuote()` itself
 * never does — so this file, which is the only one that converts through
 * the actual mounted procedure, is where the wiring can be proven to fire
 * at all, rather than relying on the SMTP-not-configured console warning.
 */
const mail: Array<{ to: string; subject: string; text: string }> = [];

beforeAll(() => {
  setTransportForTests({
    sendMail: async (message) => {
      mail.push({
        to: String(message.to),
        subject: String(message.subject),
        text: String(message.text ?? ''),
      });
    },
  });
});

afterAll(() => {
  resetTransportForTests();
});

// File-level, not `describeWithDb`'s own: the pure guard below (`'declares
// the new transferQuoting gate'`) also runs with the transport installed,
// and "mail is empty when a test starts" should hold for every test in this
// file unconditionally rather than only for the inner suite.
beforeEach(() => {
  mail.length = 0;
});

/** This file's own day — distinct from every other transfer suite's. */
const DAY = '2099-11-20';
const NOT_FOUND_SENTINEL_ID = 2_000_000_300;

const created = {
  userIds: [] as number[],
  inquiryIds: [] as number[],
  bookingIds: [] as number[],
  vanIds: [] as number[],
  driverIds: [] as number[],
};

let seq = 0;
const unique = () => {
  seq += 1;
  return `${seq}-${Math.floor(Math.random() * 1e9)}-${Date.now()}`;
};

let ownerId = 0;
let dispatcherId = 0;
let financeId = 0;
let VAN_ID = 0;

const ownerApi = () => appRouter.createCaller(staffContext(ownerId, 'owner') as never);
const dispatcherApi = () =>
  appRouter.createCaller(staffContext(dispatcherId, 'dispatcher') as never);
const financeApi = () => appRouter.createCaller(staffContext(financeId, 'finance') as never);
const anonApi = () => appRouter.createCaller(testContext(null) as never);

async function makeStaff(role: 'owner' | 'dispatcher' | 'finance') {
  const suffix = unique();
  const [row] = await getDb()
    .insert(users)
    .values({
      name: `Transfer quotes ${role} ${suffix}`,
      email: `admxferq_${role}_${suffix}@example.test`,
      passwordHash: '__admxferq_fixture_not_a_hash__',
      role,
      isActive: true,
    });
  created.userIds.push(row.insertId);
  return row.insertId;
}

async function vehicleTypeIdBySlug(slug: string): Promise<number> {
  const [row] = await getDb()
    .select({ id: vehicleTypes.id })
    .from(vehicleTypes)
    .where(eq(vehicleTypes.slug, slug))
    .limit(1);
  if (!row) throw new Error(`No vehicle_types row for slug "${slug}"`);
  return row.id;
}

async function makeVan() {
  const suffix = unique();
  const [row] = await getDb()
    .insert(vans)
    .values({
      plate: `AQ${suffix}`.slice(0, 20),
      model: 'Transfer Quotes Fixture',
      capacity: 12,
      vehicleTypeId: VAN_ID,
      status: 'available',
      isActive: true,
    });
  created.vanIds.push(row.insertId);
  return row.insertId;
}

async function makeDriver() {
  const suffix = unique();
  const [row] = await getDb()
    .insert(drivers)
    .values({
      name: `Transfer Quotes Fixture ${suffix}`,
      code: `AQ${suffix}`.slice(0, 20),
      phone: '09170000000',
      pinHash: '__admxferq_not_a_pin_hash__',
      maxTransferJobsPerDay: 4,
      isActive: true,
    });
  created.driverIds.push(row.insertId);
  return row.insertId;
}

/**
 * Through `inquiries.create`, never a raw INSERT — the public mutation is
 * the one writer, and this is the exact shape T17 built. `routeDescription`
 * can be forced to a blank string after the fact (a DB write the public
 * schema itself refuses) to exercise `missing_route_description`, which is a
 * malformed-row case rather than a guest choice.
 */
async function createInquiry(
  opts: { pax?: number; routeDescription?: string; phone?: string | null; type?: 'contact' } = {},
) {
  const suffix = unique();
  const email = `admxferq_guest_${suffix}@example.test`;
  await anonApi().inquiries.create(
    opts.type === 'contact'
      ? {
          type: 'contact',
          name: 'Maria Santos',
          email,
          message: `General question ${suffix}`,
          consent: true,
        }
      : {
          type: 'transfer_custom',
          name: 'Maria Santos',
          email,
          message: `Custom trip notes ${suffix}`,
          requestedDate: DAY,
          pax: opts.pax ?? 4,
          routeDescription: opts.routeDescription ?? 'Mactan airport to a private resort in Argao',
          consent: true,
        },
  );
  const [row] = await getDb()
    .select({ id: inquiries.id })
    .from(inquiries)
    .where(eq(inquiries.email, email));
  const id = row?.id ?? 0;
  created.inquiryIds.push(id);
  if (opts.phone !== undefined) {
    await getDb().update(inquiries).set({ phone: opts.phone }).where(eq(inquiries.id, id));
  }
  return { id, email };
}

async function forceRouteDescription(inquiryId: number, value: string | null) {
  await getDb()
    .update(inquiries)
    .set({ routeDescription: value })
    .where(eq(inquiries.id, inquiryId));
}

async function forcePax(inquiryId: number, value: number | null) {
  await getDb().update(inquiries).set({ pax: value }).where(eq(inquiries.id, inquiryId));
}

async function inquiryRow(id: number) {
  const [row] = await getDb().select().from(inquiries).where(eq(inquiries.id, id));
  return row;
}

async function bookingRow(id: number) {
  const [row] = await getDb().select().from(bookings).where(eq(bookings.id, id));
  if (!row) throw new Error(`booking ${id} not found`);
  return row;
}

/**
 * One well-formed convert input, every field a caller would send — the WIRE
 * shape (`transferQuoteConvertInput`'s own `.optional()` fields, undefined
 * for absent), for calls through the real `admin.transferQuotes.convert`
 * procedure.
 */
function convertInput(
  inquiryId: number,
  over: Partial<TransferQuoteConvertInput> = {},
): TransferQuoteConvertInput {
  return {
    inquiryId,
    vehicleTypeId: VAN_ID,
    productType: 'transfer_one_way',
    date: DAY,
    pickupTime: '08:00',
    customRouteDurationMinutes: 90,
    pax: 4,
    luggageCount: 2,
    pickup: 'Mactan-Cebu International Airport, Terminal 2',
    dropoffAddress: 'A private resort in Argao',
    leadPhone: '09171234567',
    priceCentavos: 450_000,
    ...over,
  };
}

/**
 * The SERVICE shape (`ConvertTransferQuoteInput`'s own null-for-absent
 * convention, matching `CreateTransferBookingInput`) — only for the one test
 * that calls `convertTransferQuote()` directly rather than through the
 * router, to drive a real race between two in-flight calls.
 */
function serviceInput(
  inquiryId: number,
  over: Partial<ConvertTransferQuoteInput> = {},
): ConvertTransferQuoteInput {
  return {
    inquiryId,
    vehicleTypeId: VAN_ID,
    productType: 'transfer_one_way',
    date: DAY,
    pickupTime: '08:00',
    dayUseEndTime: null,
    customRouteDurationMinutes: 90,
    pax: 4,
    luggageCount: 2,
    pickup: 'Mactan-Cebu International Airport, Terminal 2',
    pickupMapUrl: null,
    dropoffAddress: 'A private resort in Argao',
    dropoffMapUrl: null,
    flightNumber: null,
    airline: null,
    leadPhone: '09171234567',
    priceCentavos: 450_000,
    ...over,
  };
}

async function cleanup() {
  const pool = getPool();
  const db = getDb();
  /*
   * Inquiries FIRST: `inquiries.converted_booking_id` is a plain RESTRICT FK
   * onto `bookings.id` (schema.ts's own note — no hard deletes, so no
   * `onDelete` either), so deleting a booking a surviving inquiry still
   * points at throws and aborts this whole function, leaving every table
   * below untouched. Deleting the inquiry first clears that reference.
   */
  for (const id of created.inquiryIds) {
    await pool.query('DELETE FROM inquiries WHERE id = ?', [id]);
  }
  for (const id of created.bookingIds) {
    await pool.query('DELETE FROM audit_log WHERE entity = ? AND entity_id = ?', ['bookings', id]);
    await db.delete(bookingTransferDetails).where(eq(bookingTransferDetails.bookingId, id));
    await pool.query('DELETE FROM bookings WHERE id = ?', [id]);
  }
  for (const id of created.driverIds) await db.delete(drivers).where(eq(drivers.id, id));
  for (const id of created.vanIds) await db.delete(vans).where(eq(vans.id, id));
  await pool.query('DELETE FROM fleet_date_slots WHERE date = ?', [DAY]);
  created.bookingIds = [];
  created.inquiryIds = [];
  created.driverIds = [];
  created.vanIds = [];
}

/* ------------------------------------------------------------------ *
 * Pure guard — no database.
 * ------------------------------------------------------------------ */

it('declares the new transferQuoting gate on the mounted procedure', () => {
  const mounted = (
    appRouter as unknown as { _def: { procedures: Record<string, { _def?: { meta?: unknown } }> } }
  )._def.procedures;
  expect(
    mounted['admin.transferQuotes.convert'],
    'admin.transferQuotes.convert is not mounted',
  ).toBeDefined();
  expect(mounted['admin.transferQuotes.convert']?._def?.meta).toMatchObject({
    access: 'admin',
    area: 'transferQuoting',
    roles: ROLE_MATRIX.transferQuoting,
  });
});

/* ------------------------------------------------------------------ *
 * The database-backed suite.
 * ------------------------------------------------------------------ */

describeWithDb('admin.transferQuotes.convert', () => {
  beforeEach(async () => {
    ownerId = await makeStaff('owner');
    dispatcherId = await makeStaff('dispatcher');
    financeId = await makeStaff('finance');
    VAN_ID = await vehicleTypeIdBySlug('van');
  });

  afterEach(async () => {
    await cleanup();
    for (const id of created.userIds) await getDb().delete(users).where(eq(users.id, id));
    created.userIds = [];
  });

  /* ---------------------------------------------------------------- *
   * The role boundary — the task's own dual-trigger, end to end.
   * ---------------------------------------------------------------- */

  it('DENIES dispatcher — the gate, not a hidden button', async () => {
    const { id: inquiryId } = await createInquiry();
    await makeVan();
    await makeDriver();

    await expect(
      dispatcherApi().admin.transferQuotes.convert(convertInput(inquiryId)),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });

    expect(await inquiryRow(inquiryId)).toMatchObject({ convertedBookingId: null });
  });

  it('denies an anonymous caller', async () => {
    const { id: inquiryId } = await createInquiry();
    await expect(
      anonApi().admin.transferQuotes.convert(convertInput(inquiryId)),
    ).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
  });

  it('ALLOWS owner to convert', async () => {
    const { id: inquiryId, email } = await createInquiry();
    await makeVan();
    await makeDriver();

    const result = await ownerApi().admin.transferQuotes.convert(convertInput(inquiryId));
    created.bookingIds.push(result.bookingId);

    expect(result.ref).toMatch(/^RG-/);
    expect((await inquiryRow(inquiryId))?.convertedBookingId).toBe(result.bookingId);

    // Task T21's guest notice — sent by the router AFTER the commit above,
    // not by `convertTransferQuote()` itself. This is the one test in the
    // codebase that proves `sendQuoteReadyNotice` actually fires.
    expect(mail).toHaveLength(1);
    expect(mail[0]).toMatchObject({
      to: email,
      subject: `Your trip quote is ready — ${result.ref}`,
    });
    /*
     * Firing proves only that the call site survived; it says nothing
     * about the LEFT JOIN `sendQuoteReadyNotice` reads its payload through.
     * A broken join, or a column swap, would fall back to the router's own
     * `?? 'your custom trip'` wording and this test would stay green on the
     * two assertions above alone — so assert the actual route description
     * this inquiry was created with (`createInquiry`'s own default) made it
     * into the body, proving `customRouteDescription` was read correctly.
     */
    expect(mail[0]!.text).toContain('Mactan airport to a private resort in Argao');
  });

  it('ALLOWS finance to convert', async () => {
    const { id: inquiryId } = await createInquiry();
    await makeVan();
    await makeDriver();

    const result = await financeApi().admin.transferQuotes.convert(convertInput(inquiryId));
    created.bookingIds.push(result.bookingId);

    expect((await inquiryRow(inquiryId))?.convertedBookingId).toBe(result.bookingId);
  });

  /* ---------------------------------------------------------------- *
   * The inquiry pre-checks.
   * ---------------------------------------------------------------- */

  it('refuses an inquiry id that does not exist', async () => {
    await expect(
      ownerApi().admin.transferQuotes.convert(convertInput(NOT_FOUND_SENTINEL_ID)),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('refuses a general contact inquiry (wrong_type)', async () => {
    const { id: inquiryId } = await createInquiry({ type: 'contact' });
    await expect(
      ownerApi().admin.transferQuotes.convert(convertInput(inquiryId)),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
  });

  it('refuses a request already converted', async () => {
    const { id: inquiryId } = await createInquiry();
    await makeVan();
    await makeDriver();
    const first = await ownerApi().admin.transferQuotes.convert(convertInput(inquiryId));
    created.bookingIds.push(first.bookingId);

    await expect(
      ownerApi().admin.transferQuotes.convert(convertInput(inquiryId, { pickupTime: '14:00' })),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
  });

  it('refuses a malformed row with no route description, rather than booking "null"', async () => {
    const { id: inquiryId } = await createInquiry();
    await forceRouteDescription(inquiryId, null);

    await expect(
      ownerApi().admin.transferQuotes.convert(convertInput(inquiryId)),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
  });

  /* ---------------------------------------------------------------- *
   * Fields that ride through from the inquiry, and the two that do not.
   * ---------------------------------------------------------------- */

  it('reads the route description, lead name and email straight off the inquiry, verbatim', async () => {
    const { id: inquiryId, email } = await createInquiry({
      routeDescription: 'Oslob whale-shark viewing then back to Mactan airport',
    });
    await makeVan();
    await makeDriver();

    const result = await ownerApi().admin.transferQuotes.convert(convertInput(inquiryId));
    created.bookingIds.push(result.bookingId);

    const row = await bookingRow(result.bookingId);
    expect(row.leadName).toBe('Maria Santos');
    expect(row.leadEmail).toBe(email);
    expect(row.routeId).toBeNull();
  });

  it('uses the STAFF-TYPED leadPhone, never the inquiry phone, even when the inquiry has one', async () => {
    const { id: inquiryId } = await createInquiry({ phone: '09170000000' });
    await makeVan();
    await makeDriver();

    const result = await ownerApi().admin.transferQuotes.convert(
      convertInput(inquiryId, { leadPhone: '09179998888' }),
    );
    created.bookingIds.push(result.bookingId);

    const row = await bookingRow(result.bookingId);
    expect(row.leadPhone).toBe('+639179998888');
  });

  it('converts a request whose guest gave no phone at all, using the staff-typed one', async () => {
    const { id: inquiryId } = await createInquiry({ phone: null });
    await makeVan();
    await makeDriver();

    const result = await ownerApi().admin.transferQuotes.convert(convertInput(inquiryId));
    created.bookingIds.push(result.bookingId);

    const row = await bookingRow(result.bookingId);
    expect(row.leadPhone).toBe('+639171234567');
  });

  it('uses the STAFF-TYPED pax, not the inquiry pax — converts even when the inquiry pax is null', async () => {
    const { id: inquiryId } = await createInquiry();
    await forcePax(inquiryId, null);
    await makeVan();
    await makeDriver();

    const result = await ownerApi().admin.transferQuotes.convert(
      convertInput(inquiryId, { pax: 6 }),
    );
    created.bookingIds.push(result.bookingId);

    expect((await bookingRow(result.bookingId)).pax).toBe(6);
  });

  it("puts the inquiry's own message onto the booking's requests, unedited", async () => {
    const { id: inquiryId } = await createInquiry();
    await makeVan();
    await makeDriver();

    const result = await ownerApi().admin.transferQuotes.convert(convertInput(inquiryId));
    created.bookingIds.push(result.bookingId);

    const inquiry = await inquiryRow(inquiryId);
    expect((await bookingRow(result.bookingId)).requests).toBe(inquiry?.message);
  });

  /* ---------------------------------------------------------------- *
   * The day-use branch and the duration this task adds.
   * ---------------------------------------------------------------- */

  it('converts a day-use request with no duration, and freezes none', async () => {
    const { id: inquiryId } = await createInquiry();
    await makeVan();
    await makeDriver();

    const result = await ownerApi().admin.transferQuotes.convert(
      convertInput(inquiryId, {
        productType: 'transfer_day_use',
        dayUseEndTime: '18:00',
        customRouteDurationMinutes: undefined,
      }),
    );
    created.bookingIds.push(result.bookingId);
    expect((await bookingRow(result.bookingId)).productType).toBe('transfer_day_use');

    // Dedicated-review should-fix #4: the title's own "freezes none" half,
    // actually asserted rather than merely claimed.
    const [details] = await getDb()
      .select({ routeDurationMinutesUsed: bookingTransferDetails.routeDurationMinutesUsed })
      .from(bookingTransferDetails)
      .where(eq(bookingTransferDetails.bookingId, result.bookingId));
    expect(details?.routeDurationMinutesUsed).toBeNull();
  });

  /* ---------------------------------------------------------------- *
   * The audit row Task T19 names.
   * ---------------------------------------------------------------- */

  it('writes a dedicated transfer.custom_quote_converted audit row naming the actor, the inquiry id and the price — alongside, not instead of, booking.held', async () => {
    const { id: inquiryId } = await createInquiry();
    await makeVan();
    await makeDriver();

    const result = await financeApi().admin.transferQuotes.convert(convertInput(inquiryId));
    created.bookingIds.push(result.bookingId);

    const rows = await getDb()
      .select({
        action: auditLog.action,
        actorType: auditLog.actorType,
        actorId: auditLog.actorId,
        data: auditLog.data,
      })
      .from(auditLog)
      .where(eq(auditLog.entityId, result.bookingId));

    const converted = rows.find((r) => r.action === 'transfer.custom_quote_converted');
    expect(converted, 'no transfer.custom_quote_converted row was written').toBeDefined();
    expect(converted?.actorType).toBe('user');
    expect(converted?.actorId).toBe(financeId);
    expect(converted?.data).toMatchObject({ inquiryId, priceCentavos: 450_000 });

    // No PII: name, email and phone must not be in the payload.
    const payload = JSON.stringify(converted?.data ?? {});
    expect(payload).not.toContain('Maria');
    expect(payload).not.toContain('09171234567');

    expect(
      rows.some((r) => r.action === 'booking.held'),
      'booking.held must still be written',
    ).toBe(true);
  });

  /* ---------------------------------------------------------------- *
   * The race this module's own header describes.
   * ---------------------------------------------------------------- */

  it(
    'lets exactly one of two concurrent conversions of the SAME inquiry link it, ' +
      'and names both booking refs on the loser',
    async () => {
      const { id: inquiryId } = await createInquiry();
      await makeVan();
      await makeVan();
      await makeDriver();
      await makeDriver();

      const results = await Promise.allSettled([
        convertTransferQuote({ ...serviceInput(inquiryId), pickupTime: '06:00' }, ownerId),
        convertTransferQuote({ ...serviceInput(inquiryId), pickupTime: '20:00' }, financeId),
      ]);

      const fulfilled = results.filter(
        (r): r is PromiseFulfilledResult<Awaited<ReturnType<typeof convertTransferQuote>>> =>
          r.status === 'fulfilled',
      );
      const rejected = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
      expect(fulfilled, 'exactly one conversion should have won the race').toHaveLength(1);
      expect(rejected).toHaveLength(1);
      for (const r of fulfilled) created.bookingIds.push(r.value.bookingId);

      const error = rejected[0]?.reason;
      expect(error).toBeInstanceOf(TransferQuoteConvertRaceError);
      const raceError = error as TransferQuoteConvertRaceError;
      created.bookingIds.push(raceError.newBookingId);
      expect(raceError.existingBookingId).toBe(fulfilled[0]?.value.bookingId);
      expect(raceError.message).toContain(raceError.newBookingRef);

      expect((await inquiryRow(inquiryId))?.convertedBookingId).toBe(raceError.existingBookingId);
    },
  );
});
