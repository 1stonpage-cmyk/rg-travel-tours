import { formatPeso } from '@rg/shared';

type Tier = { minPax: number; maxPax: number; pricePerPersonCentavos: number };

type Props = { tiers: Tier[] };

/**
 * The tour's price tiers, as INFORMATION — "group size X pays Y per
 * person" — never a quote. Nothing here multiplies a tier's price by a
 * head count; that number only ever comes from `checkout.quote`
 * (`BookingPicker`). `overflow-x-auto` wraps the table rather than letting
 * it force the page wider on a 360px screen.
 */
export default function PriceTierTable({ tiers }: Props) {
  if (tiers.length === 0) return null;

  return (
    <div className="border-brand-blue-200 overflow-x-auto rounded-xl border">
      <table className="w-full text-left text-sm">
        <caption className="sr-only">Price per person by group size</caption>
        <thead className="bg-brand-blue-50">
          <tr>
            <th scope="col" className="text-brand-blue-900 px-4 py-3 font-semibold">
              Group size
            </th>
            <th scope="col" className="text-brand-blue-900 px-4 py-3 font-semibold">
              Price per person
            </th>
          </tr>
        </thead>
        <tbody>
          {tiers.map((tier) => (
            <tr key={`${tier.minPax}-${tier.maxPax}`} className="border-brand-blue-100 border-t">
              <td className="px-4 py-3">
                {tier.minPax === tier.maxPax
                  ? `${tier.minPax} guest${tier.minPax === 1 ? '' : 's'}`
                  : `${tier.minPax}–${tier.maxPax} guests`}
              </td>
              <td className="text-brand-blue-900 px-4 py-3 font-semibold">
                {formatPeso(tier.pricePerPersonCentavos)}{' '}
                <span className="text-muted-foreground font-normal">/ person</span>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
