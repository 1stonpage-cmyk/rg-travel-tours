import { z, type ZodError } from 'zod';

export interface FlattenedZodError {
  formErrors: string[];
  fieldErrors: Record<string, string[]>;
  nestedFieldErrors: Record<string, string[]>;
}

/**
 * BUG-120's dot-path flattener (originally `server/src/trpc.ts`'s private
 * `flatten()`), extracted here so the server's `errorFormatter` and a
 * client-side PRE-SUBMIT validation pass (`client/src/lib/field-errors.ts`)
 * read one formula instead of two that can drift. See `trpc.ts`'s own
 * comment for the server-only `scrubPaths` step this file deliberately does
 * not apply.
 */
export function flattenZodError(error: ZodError): FlattenedZodError {
  const flat = z.flattenError(error);

  const nestedFieldErrors: Record<string, string[]> = {};
  for (const issue of error.issues) {
    if (issue.path.length < 2) continue;
    const key = issue.path.join('.');
    (nestedFieldErrors[key] ??= []).push(issue.message);
  }

  return {
    formErrors: flat.formErrors,
    fieldErrors: Object.fromEntries(
      Object.entries(flat.fieldErrors).map(([k, v]) => [k, v ?? []]),
    ) as Record<string, string[]>,
    nestedFieldErrors,
  };
}
