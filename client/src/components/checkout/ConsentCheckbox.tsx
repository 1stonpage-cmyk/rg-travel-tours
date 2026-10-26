import { Label } from '@/components/ui/label';
import { SITE } from '@/lib/site';

type Props = {
  error: string | null;
  onChange: () => void;
};

/**
 * RA 10173 (Data Privacy Act) consent, for the hold `checkout.createHold`
 * is about to create. Follows `ContactSection.tsx`'s pattern exactly (Task
 * 8 brief): a plain, uncontrolled checkbox (never HTML `required` — the
 * page's own submit handler blocks and explains instead) whose label names
 * the LEGAL OPERATOR (`SITE.legalOperator`, "R&G Travel & Tours"), not the
 * consumer-facing brand. Consent is a legal matter; the brand is marketing
 * copy. See CLAUDE.md and `client/src/lib/site.ts`.
 *
 * Task 2E (2026-10-27): the label now links Terms of Service, Privacy Policy
 * and Refund Policy — text/link change only, same checkbox, same validation,
 * same submit-blocks-and-explains behaviour. Each link opens in a new tab
 * (`target="_blank"`) so a guest never loses their in-progress hold by
 * navigating away from checkout to read them.
 */
export default function ConsentCheckbox({ error, onChange }: Props) {
  return (
    <div className="space-y-2">
      <div className="flex items-start gap-2.5">
        <input
          id="checkout-consent"
          name="consent"
          type="checkbox"
          onChange={onChange}
          className="accent-brand-blue-600 border-input mt-0.5 size-5 shrink-0 rounded"
        />
        <Label htmlFor="checkout-consent" className="text-muted-foreground text-sm font-normal">
          I agree to {SITE.legalOperator} collecting and storing my details to process this booking,
          per the Data Privacy Act (RA 10173), and to the{' '}
          <a
            href="/terms"
            target="_blank"
            rel="noreferrer noopener"
            className="text-brand-blue-700 underline underline-offset-2"
          >
            Terms of Service
          </a>
          ,{' '}
          <a
            href="/privacy"
            target="_blank"
            rel="noreferrer noopener"
            className="text-brand-blue-700 underline underline-offset-2"
          >
            Privacy Policy
          </a>{' '}
          and{' '}
          <a
            href="/refund-policy"
            target="_blank"
            rel="noreferrer noopener"
            className="text-brand-blue-700 underline underline-offset-2"
          >
            Refund Policy
          </a>
          .
        </Label>
      </div>
      {error && (
        <p role="alert" className="text-brand-error text-sm font-medium">
          {error}
        </p>
      )}
    </div>
  );
}
