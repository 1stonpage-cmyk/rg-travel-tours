/**
 * Task 8b, fix round 1 (IMPORTANT 2) — a structural guard on
 * `PayNowButton.tsx` itself, on top of the behavioural "exactly one
 * mutation call" counters in `checkout-page.test.tsx` / `booking-status
 * .test.tsx`. The two catch different things: the counters catch a SIBLING
 * mutation added next to `<PayNowButton>` at a call site; this catches a
 * SECOND mutation added INSIDE the component itself, which a call-site
 * counter would still see as "one component click, one or more calls" but
 * couldn't attribute. Neither alone is sufficient — see the review that
 * asked for both.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

describe('PayNowButton — exactly one mutation, and it is checkout.startPayment', () => {
  it('calls useMutation exactly once in this file', () => {
    const file = join(
      dirname(fileURLToPath(import.meta.url)),
      '../components/checkout/PayNowButton.tsx',
    );
    const src = readFileSync(file, 'utf8');
    const matches = src.match(/useMutation/g) ?? [];
    expect(matches).toHaveLength(1);
  });

  it('that one useMutation call is on trpc.checkout.startPayment, not some other procedure', () => {
    const file = join(
      dirname(fileURLToPath(import.meta.url)),
      '../components/checkout/PayNowButton.tsx',
    );
    const src = readFileSync(file, 'utf8');
    expect(src).toMatch(/trpc\.checkout\.startPayment\.useMutation\(\)/);
  });
});
