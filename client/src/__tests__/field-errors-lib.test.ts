/**
 * `lib/field-errors.ts` on its own (task A4).
 *
 * The form tests in `friendly-field-errors.test.tsx` prove the messages reach
 * the right inputs. This file pins the two rules that are easy to get wrong in
 * the helper itself and invisible in a rendered form:
 *
 *  1. **`null` means "not a validation failure".** Every caller branches on
 *     it to decide whether to fall through to `describeMutationError` /
 *     `describeCheckoutError` / its own banner. If an error with no `zodError`
 *     ever came back as `{}` instead, every one of those callers would take
 *     the validation branch and show nothing at all.
 *  2. **`splitFieldErrors` never drops a message.** A message keyed on a field
 *     the form does not render has to come back as the banner. Dropping it is
 *     the quiet half of this bug — a failed save with nothing on screen — and
 *     eight admin screens depend on this one function for it.
 *
 * The errors are built with `TRPCClientError.from`, which is what
 * `@trpc/client` itself uses on a JSON-RPC error response, so `error.data` is
 * populated the same way a real refusal populates it.
 */
import { TRPCClientError } from '@trpc/client';
import { describe, expect, it } from 'vitest';
import {
  firstValidationMessage,
  getFieldErrors,
  getFormErrors,
  getNestedFieldError,
  splitFieldErrors,
} from '@/lib/field-errors';

/** A refusal exactly as `server/src/trpc.ts`'s `errorFormatter` shapes it. */
function refusal(data: Record<string, unknown>, message = 'nope'): TRPCClientError<never> {
  return TRPCClientError.from({
    error: { message, code: -32600, data },
  } as never);
}

const VALIDATION = {
  code: 'BAD_REQUEST',
  httpStatus: 400,
  zodError: {
    formErrors: [] as string[],
    fieldErrors: { email: ['Enter a valid email address.'] },
  },
};

describe('getFieldErrors / getFormErrors', () => {
  it('reads one message per field from the flattened zodError', () => {
    expect(getFieldErrors(refusal(VALIDATION))).toEqual({
      email: 'Enter a valid email address.',
    });
  });

  it('takes only the FIRST message for a field with several issues', () => {
    const error = refusal({
      ...VALIDATION,
      zodError: { formErrors: [], fieldErrors: { email: ['First.', 'Second.'] } },
    });
    expect(getFieldErrors(error)).toEqual({ email: 'First.' });
  });

  it('returns null — never {} — for a refusal that carries no zodError', () => {
    const error = refusal({ code: 'CONFLICT', httpStatus: 409 }, 'That plate already exists.');
    expect(getFieldErrors(error)).toBeNull();
    expect(getFormErrors(error)).toEqual([]);
    expect(firstValidationMessage(error)).toBeNull();
  });

  it('returns null for anything that is not a tRPC client error at all', () => {
    expect(getFieldErrors(new Error('network down'))).toBeNull();
    expect(getFieldErrors(undefined)).toBeNull();
    expect(getFormErrors('a string')).toEqual([]);
  });

  it('ignores a field whose message list is empty or blank', () => {
    const error = refusal({
      ...VALIDATION,
      zodError: { formErrors: [], fieldErrors: { email: [], name: ['   '] } },
    });
    expect(getFieldErrors(error)).toBeNull();
  });
});

/**
 * BUG-120: `createHoldInput.lead` is a nested object, and `fieldErrors`
 * groups the whole thing under one `lead` key. These pin `getNestedFieldError`
 * against the real wire shape `server/src/trpc.ts`'s `flatten()` now
 * publishes — `nestedFieldErrors`, dot-path keyed, alongside the unchanged
 * `fieldErrors` map.
 */
describe('getNestedFieldError', () => {
  const NESTED = {
    code: 'BAD_REQUEST',
    httpStatus: 400,
    zodError: {
      formErrors: [] as string[],
      fieldErrors: { lead: ['Enter a valid PH mobile number, like 0917 123 4567'] },
      nestedFieldErrors: {
        'lead.phone': ['Enter a valid PH mobile number, like 0917 123 4567'],
      },
    },
  };

  it("reads the leaf's own message when the server published one", () => {
    const error = refusal(NESTED);
    expect(getNestedFieldError(error, 'lead.phone')).toBe(
      'Enter a valid PH mobile number, like 0917 123 4567',
    );
  });

  it('is null for a sibling leaf that was never wrong — the whole point of the fix', () => {
    const error = refusal(NESTED);
    expect(getNestedFieldError(error, 'lead.name')).toBeNull();
    expect(getNestedFieldError(error, 'lead.email')).toBeNull();
  });

  it("falls back to the parent key's grouped message when no leaf-level message exists", () => {
    // An older server (or a refusal with no nestedFieldErrors at all) must
    // leave every existing caller exactly as well off as before this fix.
    const error = refusal({
      ...NESTED,
      zodError: {
        formErrors: [],
        fieldErrors: { lead: ['Enter a valid PH mobile number, like 0917 123 4567'] },
      },
    });
    expect(getNestedFieldError(error, 'lead.phone')).toBe(
      'Enter a valid PH mobile number, like 0917 123 4567',
    );
    // The fallback is the GROUP message, so it is not leaf-specific — every
    // sub-field falls back to the same sentence, which is exactly today's
    // (pre-fix) behaviour and no worse.
    expect(getNestedFieldError(error, 'lead.name')).toBe(
      'Enter a valid PH mobile number, like 0917 123 4567',
    );
  });

  it('returns null for a non-validation refusal', () => {
    const error = refusal({ code: 'FORBIDDEN', httpStatus: 403 }, 'Only the owner may do that.');
    expect(getNestedFieldError(error, 'lead.phone')).toBeNull();
  });
});

describe('firstValidationMessage', () => {
  it('prefers a form-level issue over a field one', () => {
    const error = refusal({
      ...VALIDATION,
      zodError: {
        formErrors: ['That price is out of date.'],
        fieldErrors: { email: ['Enter a valid email address.'] },
      },
    });
    expect(firstValidationMessage(error)).toBe('That price is out of date.');
  });

  it('falls back to the first field message when there is no form-level issue', () => {
    expect(firstValidationMessage(refusal(VALIDATION))).toBe('Enter a valid email address.');
  });
});

describe('splitFieldErrors', () => {
  const placed = new Set(['name', 'email']);

  it('places the fields the form renders and leaves the banner empty', () => {
    const error = refusal({
      ...VALIDATION,
      zodError: {
        formErrors: [],
        fieldErrors: { name: ['Enter a name.'], email: ['Enter a valid email address.'] },
      },
    });
    expect(splitFieldErrors(error, placed)).toEqual({
      fields: { name: 'Enter a name.', email: 'Enter a valid email address.' },
      banner: null,
    });
  });

  /** The rule this function exists for. */
  it('sends a message for an UNRENDERED field to the banner rather than dropping it', () => {
    const error = refusal({
      ...VALIDATION,
      zodError: {
        formErrors: [],
        fieldErrors: {
          email: ['Enter a valid email address.'],
          newPriceCentavos: ['Enter an amount in pesos.'],
        },
      },
    });
    const split = splitFieldErrors(error, placed);
    expect(split).not.toBeNull();
    expect(split!.fields).toEqual({ email: 'Enter a valid email address.' });
    expect(split!.banner).toBe('Enter an amount in pesos.');
  });

  it('answers a form-level-only failure with an empty field map and the issue in the banner', () => {
    const error = refusal({
      ...VALIDATION,
      zodError: { formErrors: ['Send at least one change.'], fieldErrors: {} },
    });
    expect(splitFieldErrors(error, placed)).toEqual({
      fields: {},
      banner: 'Send at least one change.',
    });
  });

  it('returns null for a non-validation refusal, so the caller keeps its own path', () => {
    const error = refusal({ code: 'FORBIDDEN', httpStatus: 403 }, 'Only the owner may do that.');
    expect(splitFieldErrors(error, placed)).toBeNull();
  });
});
