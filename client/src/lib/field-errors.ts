/**
 * Reading the server's STRUCTURED validation errors, so a guest sees a
 * sentence beside the field that failed (task A4).
 *
 * ## The bug this closes
 *
 * `server/src/trpc.ts`'s `errorFormatter` already publishes
 * `error.data.zodError = { formErrors, fieldErrors }` — Zod's own
 * `flattenError`, one array of messages per top-level field name — alongside
 * `error.message`. Nothing in the client read it. Every form rendered
 * `error.message` instead (directly, or through
 * `describeMutationError`/`describeCheckoutError`, which pass a 4xx's
 * message straight through), and for a multi-issue `ZodError` that message
 * is tRPC's own default: `JSON.stringify(error.issues, null, 2)`. So a guest
 * who typed a landline at checkout was shown a JSON-shaped blob of Zod
 * issue objects, or — on a single-issue failure — a bare, context-free
 * "Expected a PH mobile number" with no indication of which box was wrong.
 *
 * ## What this module is, and is not
 *
 * It is a READER, not a second validator and not a translation table. The
 * messages are the schemas' own (`shared/src/*.ts`), which is why Part 1 of
 * this task improved them at the source rather than mapping field names to
 * client-side copy here: one place says what a bad phone number is, and
 * every surface inherits it.
 *
 * `getFieldErrors` returns **null** — not an empty object — when the error
 * carries no `zodError`. That is the signal for "this was not an input
 * validation failure" (a role refusal, a `CONFLICT`, a 429, a gateway
 * error), and callers fall through to whatever they already use for those
 * (`describeMutationError`, `describeCheckoutError`, an admin page's own
 * banner). There is deliberately no third fallback path invented here.
 *
 * ## The field NAMES are the server's, and they are only one level deep
 *
 * `flattenError` groups by `issue.path[0]`, so a nested object reports under
 * its own key: `createHoldInput.lead.phone` failing arrives as
 * `fieldErrors.lead`, never `fieldErrors.phone`. A caller must look up the
 * key the server actually sends or it silently shows nothing — see
 * `GuestDetails.tsx`, which renders the `lead` message against the
 * name/email/phone group for exactly this reason.
 */
import { TRPCClientError } from '@trpc/client';

/** One message per field, keyed by the field name the SERVER reported. */
export type FieldErrors = Record<string, string>;

/**
 * The shape `server/src/trpc.ts`'s `flatten()` writes into `data.zodError`.
 *
 * Declared here rather than reused from an `AppRouter`-derived error type on
 * purpose: `TRPCClientError`'s own `data` is typed from tRPC's DEFAULT error
 * shape (which is also why `data.httpStatus` reads cleanly in
 * `mutation-errors.ts` but `data.zodError` does not exist on it), and this
 * project's custom `errorFormatter` return type is not exported anywhere the
 * client can reach without importing server internals. The narrow local
 * declaration plus the runtime checks below is the honest version: nothing
 * here trusts the shape it was handed.
 */
interface WireZodError {
  formErrors?: unknown;
  fieldErrors?: unknown;
}

function readZodError(error: unknown): WireZodError | null {
  if (!(error instanceof TRPCClientError)) return null;
  const data: unknown = error.data;
  if (typeof data !== 'object' || data === null) return null;
  const zodError = (data as { zodError?: unknown }).zodError;
  if (typeof zodError !== 'object' || zodError === null) return null;
  return zodError as WireZodError;
}

/** Every entry of `messages` that is a usable, non-blank string. */
function firstString(messages: unknown): string | null {
  if (!Array.isArray(messages)) return null;
  for (const message of messages) {
    if (typeof message === 'string' && message.trim() !== '') return message;
  }
  return null;
}

/**
 * One friendly message per failing field, or `null` when this error is not
 * an input-validation failure at all.
 *
 * The FIRST message per field is taken: a field with two issues (an email
 * that is both malformed and over-long) gets the first, because a stack of
 * sentences under one input is noise and fixing the first usually clears the
 * rest. The ordering is Zod's own issue order, which is the schema's order.
 */
export function getFieldErrors(error: unknown): FieldErrors | null {
  const zodError = readZodError(error);
  if (!zodError) return null;

  const raw = zodError.fieldErrors;
  if (typeof raw !== 'object' || raw === null) return null;

  const fields: FieldErrors = {};
  for (const [field, messages] of Object.entries(raw as Record<string, unknown>)) {
    const message = firstString(messages);
    if (message !== null) fields[field] = message;
  }
  return Object.keys(fields).length > 0 ? fields : null;
}

/**
 * The validation issues that belong to no single field — Zod's `formErrors`,
 * i.e. a `.refine()` on the whole object, or a `.strict()` violation.
 * Rendered once above the form, never per field. Always an array, so a
 * caller can map it without a null check.
 */
export function getFormErrors(error: unknown): string[] {
  const zodError = readZodError(error);
  if (!zodError) return [];
  const raw = zodError.formErrors;
  if (!Array.isArray(raw)) return [];
  return raw.filter((message): message is string => typeof message === 'string' && message !== '');
}

/**
 * The one sentence to show a guest for a validation failure that has no
 * per-field home on the screen in front of them — a banner on a screen
 * whose form does not render that field, say.
 *
 * It exists so that `error.message` (the raw JSON issue blob) is never the
 * fallback. Form-level issues come first because they are about the whole
 * submission; otherwise it is the first field's own message. Returns `null`
 * for anything that is not a validation failure, which is the caller's cue
 * to use its existing generic handling unchanged.
 */
export function firstValidationMessage(error: unknown): string | null {
  const formErrors = getFormErrors(error);
  if (formErrors.length > 0) return formErrors[0]!;
  const fields = getFieldErrors(error);
  if (!fields) return null;
  const first = Object.values(fields)[0];
  return first ?? null;
}
