/**
 * The ONE `{{token}}` substitution helper (CLAUDE.md "Content tokens" rule:
 * a second token type requires extracting a shared helper before adding it,
 * rather than growing a second copy of the same split/replace logic).
 *
 * Used by `FaqSection.tsx`'s `{{paymentMethods}}` token and by
 * `lib/whatsapp-message.ts`'s `{{route}}`/`{{trip}}`/etc. tokens — the admin
 * settings preview reads through the latter too, so all three stay on one
 * formula.
 *
 * Per LINE: a line whose token(s) ALL resolve to an empty string is dropped
 * entirely — not just the token, the whole line (e.g. a template's optional
 * "Bags: {{bags}}" line vanishes rather than rendering "Bags: "). A line with
 * no token, or at least one non-empty token, passes through with every
 * token substituted. `{{paymentMethods}}`'s own sentence never resolves
 * empty (it has its own "no methods" fallback), so this rule never fires for
 * it — the one helper is safe for both callers.
 */
const TOKEN_PATTERN = /\{\{(\w+)\}\}/g;

export function substituteTokens(text: string, values: Readonly<Record<string, string>>): string {
  return text
    .split('\n')
    .filter((line) => {
      const matches = [...line.matchAll(TOKEN_PATTERN)];
      if (matches.length === 0) return true;
      return matches.some((match) => (values[match[1]!] ?? '') !== '');
    })
    .map((line) => line.replace(TOKEN_PATTERN, (_whole, name: string) => values[name] ?? ''))
    .join('\n');
}
