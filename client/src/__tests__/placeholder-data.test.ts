import { describe, expect, it } from 'vitest';
import {
  DESTINATIONS,
  FAQS,
  HOW_IT_WORKS,
  MOST_VISITED,
  PACKAGES,
  PLACEHOLDER_SETTINGS,
  REVIEWS,
  TOURS,
  USING_PLACEHOLDER_DATA,
  WHY_BOOK_DIRECT,
  formatPeso,
} from '@/lib/placeholder-data';

describe('placeholder data', () => {
  it('is explicitly flagged as placeholder', () => {
    expect(USING_PLACEHOLDER_DATA).toBe(true);
  });

  it('matches the counts the spec requires', () => {
    expect(DESTINATIONS).toHaveLength(6);
    expect(TOURS).toHaveLength(6);
    expect(MOST_VISITED).toHaveLength(6);
    expect(WHY_BOOK_DIRECT).toHaveLength(6);
    expect(PACKAGES).toHaveLength(3);
    expect(FAQS).toHaveLength(7);
    expect(HOW_IT_WORKS.length).toBeGreaterThanOrEqual(3);
    expect(REVIEWS.length).toBeGreaterThan(0);
  });

  it('stores every price as integer centavos', () => {
    for (const tour of TOURS) expect(Number.isInteger(tour.fromPriceCentavos)).toBe(true);
    for (const pkg of PACKAGES) {
      expect(Number.isInteger(pkg.oldPriceCentavos)).toBe(true);
      expect(Number.isInteger(pkg.newPriceCentavos)).toBe(true);
      expect(pkg.newPriceCentavos).toBeLessThan(pkg.oldPriceCentavos);
    }
  });

  it('formats centavos as whole pesos', () => {
    expect(formatPeso(150000)).toBe('₱1,500');
    expect(formatPeso(0)).toBe('₱0');
  });

  it('keeps the deposit percent and promo code aligned with the spec', () => {
    expect(PLACEHOLDER_SETTINGS.depositPercent).toBe(30);
    expect(PLACEHOLDER_SETTINGS.promoCode).toBe('RGTOURS10');
  });

  it('keeps the client-supplied trust figures accurate, with no invented review count', () => {
    expect(PLACEHOLDER_SETTINGS.ratingAverage).toBe(4.9);
    expect(PLACEHOLDER_SETTINGS.guestsServed).toBe(15000);
    expect(PLACEHOLDER_SETTINGS.ratingCount).toBeNull();
  });

  it('gives every image an alt text', () => {
    for (const item of [...TOURS, ...MOST_VISITED, ...PACKAGES]) {
      expect(item.alt.length).toBeGreaterThan(5);
    }
  });

  it('includes at least one tour with zero weekly bookings to exercise the hide rule', () => {
    expect(TOURS.some((t) => t.bookedThisWeek === 0)).toBe(true);
  });
});
