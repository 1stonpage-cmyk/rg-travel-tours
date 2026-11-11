/**
 * The hour/minute split shared by the admin screen (which shows an admin-
 * entered value exactly, e.g. "3 hr 30 min") and the guest-facing estimate
 * below (which adds "about " — owner decision 2026-11-10, Decision 6).
 * Pulled out so there is exactly one place that divides by 60, rather than
 * two private copies (`AdminTransferRoutesPage.tsx` used to carry its own).
 */
export function hoursAndMinutesSplit(minutes: number): { hours: number; mins: number } {
  return { hours: Math.floor(minutes / 60), mins: minutes % 60 };
}

/** "3 hr 30 min" / "3 hr" / "45 min" — no "about": the admin-entered value, exact. */
export function exactDuration(minutes: number): string {
  const { hours, mins } = hoursAndMinutesSplit(minutes);
  if (hours === 0) return `${mins} min`;
  if (mins === 0) return `${hours} hr`;
  return `${hours} hr ${mins} min`;
}

/**
 * A transfer's `estimatedDurationMinutes` is exactly that — an estimate, not
 * a timetable — so the GUEST-facing copy says so: "about 45 min" / "about 3
 * hr" / "about 3 hr 30 min", never a bare number or a "~" shorthand.
 */
export function friendlyDuration(minutes: number): string {
  const { hours, mins } = hoursAndMinutesSplit(minutes);
  if (hours === 0) return `about ${mins} min`;
  if (mins === 0) return `about ${hours} hr`;
  return `about ${hours} hr ${mins} min`;
}
