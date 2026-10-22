/**
 * The public booking reference, and the only safe way to insert a booking
 * that needs one (plan Task 9).
 *
 * A ref is NOT a cosmetic id. BUILD_SPEC §7 logs a guest into the customer
 * portal with **ref + email**, so the ref is half a credential: anyone who
 * can guess refs can read other people's trips, pickup addresses and phone
 * numbers. That single fact decides everything in this file — the source of
 * randomness, the alphabet, and why uniqueness is settled by the database
 * rather than by a lookup.
 */
import { randomInt } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { bookings } from '../db/schema';
import type { Transaction } from '../db/client';
import { isDuplicateKeyError } from '../db/duplicate-key';

/**
 * The 30 characters a ref may contain, chosen so it survives being read
 * aloud over a bad mobile line from a kerb in Cebu: no `0`/`O`, no
 * `1`/`I`/`L`, and no `U` (which reads as `V` in a lot of handwriting).
 *
 * It must stay in lockstep with the regex in `bookingRefSchema`
 * (`shared/src/booking.ts`) — widen one without the other and this generator
 * mints refs that schema rejects, i.e. every new booking fails validation.
 */
export const REF_ALPHABET = 'ABCDEFGHJKMNPQRSTVWXYZ23456789';

/** How many characters follow `RG-`. Six over 30 letters ≈ 729 million refs. */
const REF_LENGTH = 6;

/** Attempts before `insertBookingWithRef` refuses rather than loops. */
const MAX_REF_ATTEMPTS = 5;

/**
 * `RG-` plus six characters from {@link REF_ALPHABET}: `RG-7KQ4M9`.
 * 30^6 ≈ 729 million refs, random and non-sequential.
 *
 * Randomness comes from `node:crypto`'s `randomInt` — a CSPRNG — and never
 * from `Math.random`, whose internal state is recoverable from a handful of
 * observed outputs. With `Math.random` a guest who had seen a few refs could
 * predict others and walk straight into strangers' bookings through the
 * portal login. `randomInt` also draws without modulo bias, so no character
 * is quietly more likely than another.
 */
export function generateBookingRef(): string {
  let out = '';
  for (let i = 0; i < REF_LENGTH; i += 1) out += REF_ALPHABET[randomInt(REF_ALPHABET.length)];
  return `RG-${out}`;
}

/**
 * Inserts a booking, allocating its public ref and retrying the roughly
 * 1-in-729-million collision.
 *
 * **It retries on the UNIQUE violation instead of SELECTing first.** A
 * check-then-insert ("is this ref free? yes → insert it") races any other
 * request between the two statements: both read "free", both insert, and one
 * of them either fails anyway or — on a schema without the UNIQUE index —
 * hands two guests the same reference. The index is the only thing that can
 * decide uniqueness atomically, so this asks it and reacts.
 *
 * Takes a transaction handle, like every other write in this codebase: a
 * booking is inserted inside the capacity-check transaction (§5), and an
 * insert on its own connection would escape that rollback.
 *
 * After {@link MAX_REF_ATTEMPTS} collisions it throws. It fails closed on
 * purpose — the alternatives are looping forever or returning a booking that
 * shares a ref with someone else's, and both are worse than a 500.
 *
 * `makeRef` exists only so the collision and give-up paths are testable:
 * nothing in production passes it, and it defaults to
 * {@link generateBookingRef}. Without the seam the retry loop would be
 * untestable code on a security path.
 */
export async function insertBookingWithRef(
  tx: Transaction,
  values: Omit<typeof bookings.$inferInsert, 'ref'>,
  makeRef: () => string = generateBookingRef,
): Promise<{ id: number; ref: string }> {
  for (let attempt = 0; attempt < MAX_REF_ATTEMPTS; attempt += 1) {
    const ref = makeRef();
    try {
      await tx.insert(bookings).values({ ...values, ref });
      const [row] = await tx
        .select({ id: bookings.id })
        .from(bookings)
        .where(eq(bookings.ref, ref));
      if (!row) throw new Error(`Booking ${ref} vanished between insert and read-back.`);
      return { id: row.id, ref };
    } catch (error) {
      // Only a ref collision is retryable (`isDuplicateKeyError` walks Drizzle's
      // `.cause` wrapping; see `db/duplicate-key.ts`). Anything else — a bad FK, a
      // missing column, a dead connection — is rethrown untouched, so a
      // real fault cannot hide inside five silent retries.
      if (!isDuplicateKeyError(error)) throw error;
    }
  }
  throw new Error(
    `Could not allocate a unique booking reference after ${MAX_REF_ATTEMPTS} attempts.`,
  );
}
