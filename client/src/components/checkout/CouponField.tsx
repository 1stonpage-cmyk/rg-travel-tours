import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

type Props = {
  value: string;
  onValueChange: (value: string) => void;
  applied: string | undefined;
  onApply: () => void;
  onRemove: () => void;
  error?: string | null;
  isChecking?: boolean;
};

/**
 * Coupon code entry (Task 8, week 3 checkout plan). Applying or removing a
 * code only changes what `CheckoutPage` asks `checkout.quote` for — this
 * component never prices anything itself, and the error text it shows is
 * the server's own guest-safe rejection message (§6's "server-validated:
 * active, within dates, under usage limit, minimum spend"), passed in as a
 * prop, never invented here.
 */
export default function CouponField({
  value,
  onValueChange,
  applied,
  onApply,
  onRemove,
  error,
  isChecking,
}: Props) {
  return (
    <div className="space-y-1.5">
      <Label htmlFor="checkout-coupon">Coupon code (optional)</Label>
      <div className="flex gap-2">
        <Input
          id="checkout-coupon"
          name="couponInput"
          value={value}
          onChange={(e) => onValueChange(e.target.value)}
          placeholder="e.g. RGTOURS10"
          disabled={Boolean(applied)}
          /*
           * `quoteInput.couponCode`'s own `.max(40)` (@rg/shared), mirrored
           * here so a guest cannot type past it in the first place (task A4
           * fix round 1, C1). Defence in depth only — the SERVER's bound is
           * still the authority, since the same code can arrive in the
           * `?coupon=` query param where no input element exists to cap it.
           */
          maxLength={40}
          className="tap-target flex-1"
        />
        {applied ? (
          <Button type="button" variant="outline" className="tap-target" onClick={onRemove}>
            Remove
          </Button>
        ) : (
          <Button
            type="button"
            variant="outline"
            className="tap-target"
            onClick={onApply}
            disabled={value.trim() === '' || Boolean(isChecking)}
          >
            {isChecking ? 'Checking…' : 'Apply'}
          </Button>
        )}
      </div>
      {applied && !error && (
        <p className="text-brand-blue-700 text-sm font-medium">Coupon "{applied}" applied.</p>
      )}
      {error && (
        <p role="alert" className="text-brand-error text-sm font-medium">
          {error}
        </p>
      )}
    </div>
  );
}
