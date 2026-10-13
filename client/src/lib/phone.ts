/**
 * Phone-number shapes for deep links (Week 4, Task 9).
 *
 * `lib/site.ts` already holds the BUSINESS numbers in both forms, written
 * out by hand because there are two of them and they never change. A
 * driver's number comes from the database, so it needs converting at
 * render time — hence this helper rather than a third literal.
 */

/**
 * `09170001234` -> `639170001234`, the form `wa.me` wants: international,
 * no `+`, no spaces (the same rule `lib/site.ts` documents for the
 * business numbers).
 *
 * Leaves an already-international number alone, and strips the spaces,
 * dashes and brackets a human might have typed into an admin form. It is
 * deliberately not a validator: an unusable number is a dead link, which
 * is visible, where a thrown error would be a blank card.
 */
export function waNumber(phone: string): string {
  const digits = phone.replace(/[^\d]/g, '');
  if (digits.startsWith('63')) return digits;
  if (digits.startsWith('0')) return `63${digits.slice(1)}`;
  return digits;
}
