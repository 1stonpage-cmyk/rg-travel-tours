/**
 * Manila wall clock <-> UTC instant, at the form boundary.
 *
 * CLAUDE.md: store UTC, display and compute business dates in Asia/Manila.
 * `coupons.starts_at` / `.ends_at` are UTC instants and their column comment
 * says "the admin UI converts to and from Asia/Manila" — this is that
 * conversion, and it lives on the CLIENT on purpose: an `<input
 * type="datetime-local">` has no time zone at all, so only the screen knows
 * that what was typed is Manila wall clock. Sending the raw string and letting
 * the server guess is how a coupon starts eight hours early.
 *
 * Both directions go through `@rg/shared`'s `Intl`-based helpers
 * (`manilaInstant`, `manilaCivilDate`, `manilaTimeHHMM`) rather than adding or
 * subtracting eight hours by hand: the Philippines does not observe DST today,
 * and that is a fact about the current calendar rather than something to build
 * arithmetic on.
 */
import { manilaCivilDate, manilaInstant, manilaTimeHHMM } from '@rg/shared';

/**
 * A `datetime-local` value — `YYYY-MM-DDTHH:MM`, read as Manila wall clock —
 * to the UTC ISO string the API accepts. `null` for anything that is not that
 * shape, including an empty field, so the caller turns it into "no date" or a
 * field error rather than sending `Invalid Date`.
 *
 * Seconds are accepted and DISCARDED: some browsers append `:00` to a
 * `datetime-local` value, and a coupon window has no business being precise to
 * the second.
 */
export function manilaLocalToUtcIso(local: string): string | null {
  const match = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})(?::\d{2})?$/.exec(local.trim());
  if (!match) return null;
  return manilaInstant(match[1]!, match[2]!).toISOString();
}

/**
 * The inverse, for pre-filling an edit form: a UTC ISO instant to the Manila
 * wall clock a `datetime-local` input displays.
 */
export function utcIsoToManilaLocal(iso: string): string {
  const instant = new Date(iso);
  return `${manilaCivilDate(instant)}T${manilaTimeHHMM(instant)}`;
}

/** The same instant for READING — `2026-12-01 08:00`, Manila, never UTC. */
export function utcIsoToManilaLabel(iso: string): string {
  const instant = new Date(iso);
  return `${manilaCivilDate(instant)} ${manilaTimeHHMM(instant)}`;
}
