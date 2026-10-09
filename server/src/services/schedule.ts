/**
 * Date-window resolution for the `announcement` and `promo` settings
 * blocks. `startsAt`/`endsAt` are stored as ISO-8601 UTC instants (e.g.
 * Manila midnight is `2026-10-01T16:00:00.000Z`), so this is plain instant
 * comparison — no Manila-specific logic needed here. A null bound is
 * open-ended on that side.
 */
export function isWithinWindow(startsAt: string | null, endsAt: string | null, now: Date): boolean {
  return (!startsAt || now >= new Date(startsAt)) && (!endsAt || now <= new Date(endsAt));
}
