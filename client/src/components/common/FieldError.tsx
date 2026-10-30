/**
 * One field's validation message, rendered beneath its input (task A4).
 *
 * It exists so the six public forms read as ONE system rather than six
 * near-identical paragraphs: one class string, one `role="alert"`, one id
 * convention for the `aria-describedby` the input points back with.
 * `ui-ux-pro-max` (`--domain ux`, "Error Placement" / "Error Messages",
 * both severity High) asks for exactly that pairing: a specific error below
 * the input, referenced by `aria-describedby`, and announced rather than
 * signalled by colour alone.
 *
 * **`text-brand-error` is `#334155`, a dark blue-grey, and that is not a
 * compromise.** CLAUDE.md forbids red anywhere, errors included, and
 * `client/src/__tests__/no-red.test.ts` fails the build if it reappears. The
 * message carries weight (`font-medium`) and `role="alert"` instead, so it
 * does not depend on hue to be noticed — which is the accessible behaviour
 * regardless of the palette rule.
 *
 * Renders NOTHING when there is no message, so a caller can mount it
 * unconditionally and let the data decide.
 */

/**
 * The one class string every per-field message on a public form uses.
 * Exported so a form that has to build the paragraph itself (a grid cell
 * needing a `sm:col-span-2`, say) still matches the rest.
 */
export const FIELD_ERROR_CLASS = 'text-brand-error mt-1 text-sm font-medium';

export default function FieldError({
  /** The id the input names in its `aria-describedby`. */
  id,
  message,
}: {
  id: string;
  message?: string;
}) {
  if (!message) return null;
  return (
    <p id={id} role="alert" className={FIELD_ERROR_CLASS}>
      {message}
    </p>
  );
}
