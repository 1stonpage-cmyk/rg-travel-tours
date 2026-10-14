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
import { civilDateSchema, phPhoneSchema } from './checkout';

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

/**
 * Driver CRUD input (Week 5 plan, Task 6; BUILD_SPEC §9 "Drivers"). `code` is
 * the short login code the driver types on the portal — `phPhoneSchema`
 * reused from `./checkout` rather than a private copy, same reasoning as
 * `vanInputSchema` reusing `civilDateSchema`.
 *
 * Deliberately excludes `pinHash`, the five lockout columns and `status`:
 * none of those are CRUD fields a client posts. The PIN is minted by the
 * server (`admin.drivers.create` / `.resetPin`); the lockout columns are
 * owned by the Week 6 login route and the admin unlock; `status` has no
 * admin-facing setter in this task (no `admin.drivers.setStatus` is listed in
 * the plan, unlike vans).
 */
export const driverInputSchema = z
  .object({
    name: z.string().trim().min(2).max(160),
    code: z.string().trim().min(1).max(20),
    phone: phPhoneSchema,
    licenseNo: z.string().trim().max(80).nullable(),
    licenseExpiry: civilDateSchema.nullable(),
    languages: z.array(z.string().trim().min(1).max(40)).max(20).nullable(),
    emergencyContact: z.string().trim().max(200).nullable(),
  })
  .strict();
export type DriverInput = z.infer<typeof driverInputSchema>;

/**
 * One row of the fleet-of-people list (`admin.drivers.list`).
 *
 * No `pinHash` field exists on this type — not "present but omitted at the
 * call site", structurally absent, so a `list` resolver that forgets the
 * explicit column projection fails to typecheck against this shape too.
 */
export interface DriverRow {
  id: number;
  name: string;
  code: string;
  phone: string;
  licenseNo: string | null;
  licenseExpiry: string | null;
  languages: string[] | null;
  emergencyContact: string | null;
  status: string;
  isActive: boolean;
}

/**
 * A driver leave (`admin.drivers.addLeave`). `startDate` / `endDate` are
 * civil-date strings on the wire — the router converts to the `Date` the
 * `driver_leaves.start_date` / `.end_date` `date()` columns want.
 *
 * The `endDate >= startDate` refinement mirrors the DB CHECK
 * (`driver_leaves_date_order`) at the Zod boundary, so a backwards range is a
 * 400 before any query runs — string comparison on zero-padded `YYYY-MM-DD`,
 * the same discipline `isDriverVisible` (`shared/src/portal.ts`) already
 * uses for civil dates. The CHECK still exists for defense in depth; this is
 * the layer a client actually sees.
 */
export const driverLeaveInputSchema = z
  .object({
    driverId: z.number().int().positive(),
    startDate: civilDateSchema,
    endDate: civilDateSchema,
    reason: z.string().trim().max(300).nullable(),
  })
  .strict()
  .refine((value) => value.endDate >= value.startDate, {
    message: 'endDate must be on or after startDate',
    path: ['endDate'],
  });
export type DriverLeaveInput = z.infer<typeof driverLeaveInputSchema>;
