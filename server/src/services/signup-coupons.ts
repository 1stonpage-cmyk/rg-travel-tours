/**
 * Minting a sign-up coupon (sign-up coupons plan, Task 1B-ii).
 *
 * Modelled closely on `services/booking-ref.ts`'s `insertBookingWithRef` —
 * same collision-retry shape, same alphabet, same CSPRNG discipline — because
 * a coupon code is exactly the same kind of thing a booking ref is: a public
 * identifier that must not be guessable or predictable (`node:crypto`'s
 * `randomInt`, never `Math.random`).
 *
 * **Never opens its own transaction.** `mintSignupCoupon` always runs inside
 * the CALLER's transaction — `newsletter.subscribe`'s first-time insert, or
 * its repeat-signup `FOR UPDATE` lock — so a mint and the row that links to
 * it (`newsletter_subscribers.coupon_id`) commit together or not at all.
 */
import { randomInt } from 'node:crypto';
import type { Transaction } from '../db/client';
import { isDuplicateKeyError } from '../db/duplicate-key';
import { coupons } from '../db/schema';
import { REF_ALPHABET } from './booking-ref';

/**
 * How many characters follow `WELCOME-`.
 *
 * **8, not the booking ref's 6 — and not the 4 an early sketch of this plan
 * considered.** A sign-up code is bound to one address
 * (`coupons.restricted_to_email`), so stealing someone else's code is useless
 * without also knowing that address — but FINDING that a given code string
 * exists at all is answerable through the unbounded `checkout.quote` preview
 * (see `coupons.ts`'s `CouponNotFoundError` and the design note's Ruling 1 on
 * why the preview path cannot check the email). 30^4 ≈ 810,000 candidates is
 * a small enough space to make "does WELCOME-XXXX exist" a crawlable
 * question against that unbounded endpoint; 30^8 ≈ 6.6×10^11 is not. The
 * email restriction is still the real defence against SPENDING a found code
 * — this length is what keeps merely finding one expensive too.
 */
const SIGNUP_CODE_LENGTH = 8;

/** Attempts before `mintSignupCoupon` refuses rather than loops. */
const MAX_MINT_ATTEMPTS = 5;

/** `WELCOME-` plus 8 characters from {@link REF_ALPHABET}: `WELCOME-7KQ4M9PR`. */
export function generateSignupCouponCode(): string {
  let out = '';
  for (let i = 0; i < SIGNUP_CODE_LENGTH; i += 1)
    out += REF_ALPHABET[randomInt(REF_ALPHABET.length)];
  return `WELCOME-${out}`;
}

/**
 * Inserts one sign-up coupon row for `email`, retrying the (astronomically
 * unlikely) collision on `coupons.code`'s UNIQUE index — same reasoning as
 * `insertBookingWithRef`'s own doc comment: retry-on-violation rather than
 * check-then-insert, because the latter races any other mint between the two
 * statements.
 *
 * `email` MUST already be normalised (trim + lowercase) by the caller — this
 * function does not re-normalise, so there is exactly one normalisation
 * point in the whole feature (`newsletter.subscribe`'s own first line).
 *
 * Percent is converted to basis points here, once, at mint time
 * (`discountPercent * 100`) — the coupon's `percent_bp` is then a snapshot
 * nothing re-derives later even if the `signup_coupon` setting changes.
 *
 * Fails closed after {@link MAX_MINT_ATTEMPTS}: looping forever or minting a
 * coupon that collides with another are both worse than a 500.
 */
export async function mintSignupCoupon(
  tx: Transaction,
  email: string,
  settings: { discountPercent: number; expiryDays: number },
  now: Date,
): Promise<{ id: number; code: string }> {
  for (let attempt = 0; attempt < MAX_MINT_ATTEMPTS; attempt += 1) {
    const code = generateSignupCouponCode();
    try {
      const [result] = await tx.insert(coupons).values({
        code,
        discountType: 'percent',
        percentBp: settings.discountPercent * 100,
        amountCentavos: null,
        minSpendCentavos: null,
        startsAt: null,
        endsAt: new Date(now.getTime() + settings.expiryDays * 86_400_000),
        usageLimit: 1,
        usedCount: 0,
        isActive: true,
        restrictedToEmail: email,
      });
      return { id: result.insertId, code };
    } catch (error) {
      // Only a code collision is retryable — anything else (a bad value, a
      // dead connection) is rethrown untouched, same discipline as
      // `insertBookingWithRef`.
      if (!isDuplicateKeyError(error)) throw error;
    }
  }
  throw new Error(
    `Could not mint a unique sign-up coupon code after ${MAX_MINT_ATTEMPTS} attempts.`,
  );
}
