/**
 * Shared dispatch schemas (Week 5 plan, Task 4 — the van half; later tasks
 * in this plan add drivers and assignment to this same file).
 *
 * `.strict()` on `vanInputSchema` is not decoration: it is the same guard
 * the checkout schemas use (`shared/src/checkout.ts`), and it is what stops
 * a client posting `isActive: true` or a `status` through the CRUD door
 * rather than through `admin.vans.setStatus`.
 *
 * The four civil-date fields reuse `civilDateSchema` from `./checkout`
 * (Ruling 8) rather than a third private copy of the same regex — the
 * pattern already existed twice in this tree (here and in
 * `server/src/services/capacity.ts`'s `CIVIL_DATE`, which backs a
 * programmer-error assertion and stays separate on purpose).
 */
import { z } from 'zod';
import { civilDateSchema } from './checkout';

export const vanInputSchema = z
  .object({
    plate: z.string().trim().min(3).max(20).toUpperCase(),
    model: z.string().trim().min(2).max(120),
    capacity: z.number().int().min(1).max(30),
    odometer: z.number().int().min(0).max(5_000_000).nullable(),
    lastService: civilDateSchema.nullable(),
    nextService: civilDateSchema.nullable(),
    orcrExpiry: civilDateSchema.nullable(),
    franchiseNo: z.string().trim().max(80).nullable(),
    franchiseExpiry: civilDateSchema.nullable(),
    repairNotes: z.string().trim().max(2000).nullable(),
  })
  .strict();
export type VanInput = z.infer<typeof vanInputSchema>;

/**
 * One row of the fleet list (`admin.vans.list`).
 *
 * `status` is typed as `string` rather than importing the enum from
 * `server/src/db/schema.ts`'s `VAN_STATUSES`: that array is the server's
 * authoritative list (owner decision 2026-10-14, Task 2 of this plan), and
 * `@rg/shared` must not depend on `@rg/server` to re-type it. The router
 * validates `setStatus`'s input against the real `VAN_STATUSES` directly.
 */
export interface VanRow {
  id: number;
  plate: string;
  model: string;
  capacity: number;
  status: string;
  odometer: number | null;
  lastService: string | null;
  nextService: string | null;
  orcrExpiry: string | null;
  franchiseNo: string | null;
  franchiseExpiry: string | null;
  repairNotes: string | null;
  isActive: boolean;
}
