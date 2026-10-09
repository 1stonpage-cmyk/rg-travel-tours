import { describe, expect, it } from 'vitest';
import { formatPeso } from '../money';

describe('formatPeso', () => {
  it('formats whole pesos from centavos with no space after the sign', () => {
    expect(formatPeso(189_000)).toBe('₱1,890');
    expect(formatPeso(98_000)).toBe('₱980');
    expect(formatPeso(0)).toBe('₱0');
  });

  it('rounds to the nearest peso', () => {
    expect(formatPeso(189_049)).toBe('₱1,890');
    expect(formatPeso(189_050)).toBe('₱1,891');
  });
});
