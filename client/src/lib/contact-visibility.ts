import { trpc } from '@/lib/trpc';

/**
 * Whether the public site may show "call or text this number" surfaces
 * (owner decision 2026-11-27 — the owner works at sea and cannot take
 * calls/SMS; WhatsApp, Viber, email and Facebook are unaffected and read
 * their own numbers from `@/lib/site`, not from this).
 *
 * Defaults to `true` (numbers shown) until `settings.get` resolves, matching
 * the product default and SiteFooter's own `=== true` precedent for a
 * boolean that should not flash the "hidden" state on the happy path while
 * loading. The one case this costs something is the rare admin who has
 * switched it off: a page load briefly renders the phone number before the
 * query lands. That is the accepted tradeoff — the alternative flashes a
 * number an admin is actively trying not to publish, on every single page
 * load, for every guest, whether the switch is on or off.
 */
export function useShowCallNumbers(): boolean {
  const { data: settings } = trpc.settings.get.useQuery();
  return settings?.contact.showCallNumbers ?? true;
}
