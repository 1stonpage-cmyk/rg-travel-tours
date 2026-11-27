/**
 * The WhatsApp quote-request message (owner spec, 2026-11-28, Task 1A) —
 * `settings.whatsappMessage.{general,withDetails}`, pre-written and
 * editable from Admin → Settings, never hardcoded per component.
 *
 * `general` has no tokens and is used wherever a guest hasn't told us
 * anything yet (`FloatingWhatsApp`, header, footer, `ContactSection`, legal
 * pages). `withDetails` carries `{{token}}` placeholders, filled in from
 * whatever a guest has typed so far on a route page or the transfer booking
 * form, through the one shared substitution helper (`lib/tokens.ts`) —
 * never a second copy of that logic.
 */
import { substituteTokens } from './tokens';

export const WHATSAPP_MESSAGE_TOKENS = [
  'route',
  'trip',
  'date',
  'passengers',
  'bags',
  'vehicle',
  'pickup',
] as const;

export type WhatsappMessageToken = (typeof WHATSAPP_MESSAGE_TOKENS)[number];

export type WhatsappMessageTokenValues = Partial<Record<WhatsappMessageToken, string>>;

/**
 * Fills `withDetails` in from whatever is known so far. Every allowed token
 * is always passed through to `substituteTokens` (as `''` when not yet
 * known) so a line like "Bags: {{bags}}" drops cleanly rather than leaving
 * a stray `{{bags}}` behind.
 */
export function buildWithDetailsMessage(
  template: string,
  values: WhatsappMessageTokenValues,
): string {
  const resolved: Record<string, string> = {};
  for (const token of WHATSAPP_MESSAGE_TOKENS) {
    resolved[token] = values[token]?.trim() ?? '';
  }
  return substituteTokens(template, resolved);
}
