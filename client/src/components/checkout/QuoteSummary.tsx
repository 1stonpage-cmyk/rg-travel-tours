import { formatPeso, type PayMode, type QuoteResult } from '@rg/shared';
import { Card, CardContent } from '@/components/ui/card';

type Props = {
  quote: QuoteResult;
  pax: number;
  payMode: PayMode;
};

/**
 * Renders `QuoteResult` fields exactly as the server computed them — Task 8
 * (week 3 checkout plan). CLAUDE.md: "the server computes all money"; this
 * component does not add, subtract or multiply a single centavos value. Even
 * `amountDueNowCentavos[payMode]` / `balanceCentavos[payMode]` are plain
 * object lookups, never arithmetic — the server already picked both figures
 * for every pay mode, so there is nothing left to compute here.
 */
export default function QuoteSummary({ quote, pax, payMode }: Props) {
  const dueNow = quote.amountDueNowCentavos[payMode];
  const balance = quote.balanceCentavos[payMode];

  return (
    <Card className="bg-background">
      <CardContent className="space-y-4 p-5">
        <h2 className="text-brand-blue-900 text-lg font-semibold">Price summary</h2>

        <dl className="space-y-2 text-sm">
          <div className="flex items-center justify-between gap-3">
            <dt className="text-muted-foreground">
              {formatPeso(quote.tier.pricePerPersonCentavos)} per person{' '}
              <span aria-hidden="true">·</span> {pax} {pax === 1 ? 'guest' : 'guests'}
            </dt>
            <dd className="text-brand-blue-900 shrink-0 font-medium">
              {formatPeso(quote.subtotalCentavos)}
            </dd>
          </div>

          {quote.discountCentavos > 0 && (
            <div className="flex items-center justify-between gap-3">
              <dt className="text-muted-foreground">Coupon discount</dt>
              <dd className="text-brand-blue-900 shrink-0 font-medium">
                <span aria-hidden="true">−</span>
                {formatPeso(quote.discountCentavos)}
              </dd>
            </div>
          )}

          <div className="border-brand-blue-100 flex items-center justify-between gap-3 border-t pt-2">
            <dt className="text-brand-blue-900 font-semibold">Total</dt>
            <dd className="text-brand-blue-900 shrink-0 font-semibold">
              {formatPeso(quote.totalCentavos)}
            </dd>
          </div>
        </dl>

        <div className="bg-brand-blue-50 rounded-xl p-4">
          <p className="text-muted-foreground text-xs font-medium uppercase tracking-wide">
            {payMode === 'full' ? 'Due now — paying in full' : 'Deposit due now (30%)'}
          </p>
          <p className="text-brand-blue-900 text-2xl font-bold">{formatPeso(dueNow)}</p>
          {balance > 0 && (
            <p className="text-muted-foreground mt-1 text-xs">
              {formatPeso(balance)} due on tour day
            </p>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
