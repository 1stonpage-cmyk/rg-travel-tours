/**
 * The payment seam (plan Task 13).
 *
 * **Nothing outside `server/src/services/payments/` may name a gateway.**
 * That is Phase 3's design rule, and this interface is what makes it
 * affordable: routers, the webhook route and `recordPayment()` all speak
 * `PaymentProvider`, so adding a gateway for real means writing one file in
 * this directory and adding one line to the registry — no migration (Task 12
 * proved the `payments` table carries no gateway-specific column), no router
 * change, no new webhook route shape.
 *
 * Both names below are DERIVED from the database enums rather than re-listed.
 * One definition, in `db/schema.ts`; a list typed twice is a list that
 * drifts.
 */
import type { PAYMENT_METHODS, PAYMENT_PROVIDERS } from '../../db/schema';

/** WHO processed a payment. Includes `manual`, which has no gateway — see the registry. */
export type ProviderName = (typeof PAYMENT_PROVIDERS)[number];
/** HOW the guest paid — the instrument, never the processor. */
export type PaymentMethod = (typeof PAYMENT_METHODS)[number];

export interface CreateCheckoutInput {
  /** Public booking ref — goes in the gateway's metadata so the webhook can find us. */
  bookingRef: string;
  /** What the guest owes NOW, in centavos. Computed server-side; never from the browser. */
  amountCentavos: number;
  description: string;
  /** Instruments to offer; a subset of PAYMENT_METHODS the gateway supports. */
  methods: readonly PaymentMethod[];
  successUrl: string;
  cancelUrl: string;
}

export interface CreateCheckoutResult {
  /** Where to send the guest. */
  redirectUrl: string;
  /** The gateway's id for this checkout — stored as payments.provider_ref. */
  providerRef: string;
}

/** What a webhook turned out to be, in OUR vocabulary. */
export interface ParsedPaymentEvent {
  /** The gateway's event id. Unique per provider; drives idempotency. */
  providerEventId: string;
  /** The gateway's event name, kept verbatim for the audit trail. */
  providerType: string;
  /** Normalised outcome. `ignored` means "valid event, nothing for us to do". */
  outcome: 'paid' | 'failed' | 'refunded' | 'ignored';
  bookingRef: string | null;
  amountCentavos: number | null;
  providerRef: string | null;
  providerStatus: string | null;
}

export interface RefundInput {
  providerRef: string;
  amountCentavos: number;
  reason: string;
}

export interface RefundResult {
  providerRef: string;
  providerStatus: string;
}

/**
 * Everything gateway-specific lives behind this interface.
 *
 * Nothing outside server/src/services/payments/ may name a gateway. Adding
 * Xendit for real means writing one file here and flipping one setting — not
 * a migration, not a router change, not a new webhook route shape.
 */
export interface PaymentProvider {
  readonly name: ProviderName;
  createCheckout(input: CreateCheckoutInput): Promise<CreateCheckoutResult>;
  /**
   * Returns false (or throws) on a bad signature. **NEVER returns true on
   * doubt** — a missing header, an unparseable signature, an unreadable
   * secret and a mismatch are all the same answer: false. An implementation
   * that returns true because it could not tell has handed an attacker the
   * ability to mark bookings paid.
   */
  verifyWebhook(rawBody: Buffer, headers: Record<string, string | undefined>): boolean;
  /** Only ever called on a body `verifyWebhook` has already accepted. */
  parseEvent(rawBody: Buffer): ParsedPaymentEvent;
  refund(input: RefundInput): Promise<RefundResult>;
}
