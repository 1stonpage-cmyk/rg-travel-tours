import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { BOOKING_PAGE_ROUTE, bookingPagePath } from '../constants';

/**
 * Ruling 25's own carried fix: `bookingPagePath()` used to retype
 * `'/booking/'` three lines from `BOOKING_PAGE_ROUTE`, so the "one literal,
 * not two" guarantee was asserted by nothing but a reader's attention. It
 * now derives the concrete path by substituting into the route template, so
 * there is exactly one place in the codebase that spells out the booking
 * page's path shape.
 */
describe('bookingPagePath (Ruling 25)', () => {
  it('builds the concrete path for a ref', () => {
    expect(BOOKING_PAGE_ROUTE).toBe('/booking/:ref');
    expect(bookingPagePath('RG-7KQ4M9')).toBe('/booking/RG-7KQ4M9');
  });

  it('derives from BOOKING_PAGE_ROUTE rather than retyping the path', () => {
    const src = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), '../constants.ts'),
      'utf8',
    );
    const fnStart = src.indexOf('export function bookingPagePath');
    expect(fnStart).toBeGreaterThan(-1);
    const fnBody = src.slice(fnStart);

    // The retyped form this guards against: `` `/booking/${ref}` ``.
    expect(fnBody).not.toMatch(/['"`]\/booking\//);
    expect(fnBody).toContain('BOOKING_PAGE_ROUTE');
  });
});
