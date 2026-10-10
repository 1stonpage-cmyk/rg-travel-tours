/**
 * The two names this business trades and is registered under, for server-side
 * use. `client/src/lib/site.ts` holds the browser's copy (`SITE.name` /
 * `SITE.legalOperator`); it imports from `client/src`, so the server cannot
 * reach it and needs its own.
 *
 * CLAUDE.md: keep these separate and never collapse them into one value.
 * Customer-facing copy — titles, descriptions, the `name` of the JSON-LD
 * organization — carries the BRAND. Anything regulatory, legal or financial
 * — including Schema.org's `legalName`, which means exactly that — carries
 * the LICENSED OPERATOR.
 *
 * Task 4.1 left `BRAND` as a local const in `seo/resolvers.ts` with a note to
 * decide where a server-side copy belongs once JSON-LD needed both names.
 * This is that home: a leaf module with no imports, so both `resolvers.ts`
 * and `jsonld.ts` can read it without either importing the other.
 */

/** The public trading brand — `SITE.name`. */
export const BRAND = 'TravelSugbo';

/**
 * The licensed operator — `SITE.legalOperator`. Holds the DOT/DTI/BIR
 * registrations, the PayMongo merchant account and the payment QR.
 */
export const LEGAL_OPERATOR = 'R&G Travel & Tours';
