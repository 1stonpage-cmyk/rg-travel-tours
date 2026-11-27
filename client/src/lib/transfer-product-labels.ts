import type { TransferProductType } from '@rg/shared';

/**
 * Shared with `TransferTypePicker.tsx` (its own on-screen label) and the
 * WhatsApp "withDetails" quote message (owner spec, 2026-11-28, Task 1C —
 * `TransferRoutePage.tsx`/`TransferBookingPage.tsx`'s `trip` token), so the
 * wording can never drift between the two. Kept in its own file rather than
 * exported alongside the `TransferTypePicker` component: a non-component
 * export from a component file defeats React Fast Refresh for that file.
 */
export const TRANSFER_PRODUCT_TYPE_LABELS: Record<TransferProductType, string> = {
  transfer_one_way: 'Airport transfer',
  transfer_day_use: 'Day use',
};
