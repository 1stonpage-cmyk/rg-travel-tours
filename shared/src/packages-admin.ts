/**
 * Admin packages, inquiries and the newsletter export — the shapes
 * `admin.packages.*`, `admin.inquiries.*` and `admin.newsletter.export`
 * accept and return (Week 7 plan, Task 13 — 7C; BUILD_SPEC §9 "Packages,
 * inquiries" and "Users, settings").
 *
 * **Two gates live in this one file, and that is deliberate.** Packages and
 * inquiries are `adminProcedure('packagesInquiries')` — owner and dispatcher,
 * the row added by owner decision 2026-10-23 (Q3). The newsletter export is
 * `adminProcedure('usersSettings')` — OWNER ONLY, because §9 lists "Newsletter
 * list export" under Settings and because one file holding every subscriber's
 * address is a different act from answering one enquiry. The shapes are
 * together because they are one screen; the gates are not, and the server
 * states each one on its own procedure.
 *
 * **This file describes money.** `oldPriceCentavos` / `newPriceCentavos` are
 * integer CENTAVOS (CLAUDE.md, "Money") — never a float, never a peso string.
 * A price typed as `9800.5` is a refusal at this boundary, not a rounding
 * decision downstream.
 *
 * **Every object is `.strict()`.** The screen posts exactly these fields; an
 * extra key is refused rather than quietly dropped, because an input that
 * "drops" a field it was handed looks like it might have honoured it. Three
 * columns are therefore structurally unreachable from here:
 *
 *  - `isActive` — the soft-delete switch, owned by `admin.packages.setActive`
 *    alone, exactly as `tours.is_active` is owned by `admin.tours.setActive`
 *    (CLAUDE.md, "Soft deletes"). One writer, one audit action, one question
 *    to answer when asking who retired a package.
 *  - `createdAt` / `updatedAt` — Drizzle's own `$defaultFn` / `$onUpdateFn`.
 *
 * **Nothing here can write an `inquiries` row, and nothing can write a
 * `newsletter_subscribers` row.** Both tables are filled by the PUBLIC
 * mutations that already exist and are already rate-limited
 * (`inquiries.create`, `newsletter.subscribe`). The admin side reads them,
 * moves an enquiry's status, and exports the list; it never manufactures a
 * guest's enquiry or signs anyone up.
 */
import { z } from 'zod';
import { MAX_CENTAVOS } from './tours-admin';

/* ------------------------------------------------------------------ Packages */

/** `packages.id`, and the id of a package being edited. */
const packageIdSchema = z.number().int().positive();

/** An amount of money, as this project stores money: integer centavos. */
const centavosSchema = z.number().int().nonnegative().max(MAX_CENTAVOS);

/**
 * How many days the package runs.
 *
 * At least 1 — a "multi-day package" of zero days is not a thing a guest can
 * buy — and capped at 60, which is far beyond anything TravelSugbo sells and
 * still well inside the `int` column.
 */
const daysSchema = z.number().int().min(1).max(60);

/** Where the package sits in the public list, as `packages.list` orders by. */
const sortOrderSchema = z.number().int().min(0).max(9_999);

/** A short list of bullet strings, as `packages.highlights` holds. */
const highlightsSchema = z.array(z.string().trim().min(1).max(300)).max(50).nullable();

/** Every editable column on `packages`, minus the three named in this file's header. */
const packageFields = {
  slug: z
    .string()
    .trim()
    .min(3)
    .max(160)
    .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'Use lowercase letters, numbers and hyphens.'),
  title: z.string().trim().min(3).max(200),
  days: daysSchema,
  /**
   * The struck-through "was" price, or null for a package sold at one price.
   *
   * Null is a real state the screen must be able to post, so it is required
   * and nullable rather than optional: an omitted value would be ambiguous
   * between "leave the old one" and "clear it", and `update` is a full
   * replacement.
   */
  oldPriceCentavos: centavosSchema.nullable(),
  /** What a guest is actually quoted. The only required price. */
  newPriceCentavos: centavosSchema,
  description: z.string().trim().max(20_000).nullable(),
  imagePath: z.string().trim().max(300).nullable(),
  imageAlt: z.string().trim().max(300).nullable(),
  highlights: highlightsSchema,
  sortOrder: sortOrderSchema,
  seoTitle: z.string().trim().max(200).nullable(),
  seoDescription: z.string().trim().max(400).nullable(),
  ogImage: z.string().trim().max(300).nullable(),
} as const;

/**
 * The cross-field half of the price rule: **a "was" price must really be
 * higher.**
 *
 * `oldPriceCentavos` renders struck through beside `newPriceCentavos` on
 * `/packages`, so an old price at or below the new one displays a discount
 * that does not exist — the fake social proof CLAUDE.md forbids, arrived at by
 * a typo rather than by intent. Null is untouched by this: a package with no
 * "was" price claims nothing.
 */
function discountIsReal(value: {
  oldPriceCentavos: number | null;
  newPriceCentavos: number;
}): boolean {
  return value.oldPriceCentavos === null || value.oldPriceCentavos > value.newPriceCentavos;
}

const DISCOUNT_ISSUE = {
  message: 'A "was" price has to be higher than the price you are charging now.',
  path: ['oldPriceCentavos'],
};

/**
 * **An image needs alt text.**
 *
 * CLAUDE.md asks for alt text on every image, and `packages.image_alt` is
 * nullable because the column predates this screen — so the rule is enforced
 * where a human types it rather than left to the public page, which would
 * otherwise render `alt=""` for a photograph. A package with no image needs no
 * alt text, which is why this is a pair rule and not `imageAlt.min(1)`.
 */
function imageHasAlt(value: { imagePath: string | null; imageAlt: string | null }): boolean {
  if (value.imagePath === null || value.imagePath === '') return true;
  return value.imageAlt !== null && value.imageAlt !== '';
}

const ALT_ISSUE = {
  message: 'Describe the image for a screen reader.',
  path: ['imageAlt'],
};

export const packageCreateInput = z
  .object(packageFields)
  .strict()
  .refine(discountIsReal, DISCOUNT_ISSUE)
  .refine(imageHasAlt, ALT_ISSUE);
export type PackageCreateInput = z.infer<typeof packageCreateInput>;

/**
 * The same fields plus the id — a FULL replacement, not a patch.
 *
 * Every field above is required and nullable for the reason given on
 * `oldPriceCentavos`: the editing screen loads the package and posts the whole
 * of it back, so clearing a description is `null` rather than an absence
 * somebody has to interpret.
 */
export const packageUpdateInput = z
  .object({ ...packageFields, id: packageIdSchema })
  .strict()
  .refine(discountIsReal, DISCOUNT_ISSUE)
  .refine(imageHasAlt, ALT_ISSUE);
export type PackageUpdateInput = z.infer<typeof packageUpdateInput>;

/**
 * `admin.packages.setActive`. The soft delete, modelled on `tourActiveInput`:
 * deactivating a package hides it from `packages.list` and makes
 * `packages.bySlug` answer `NOT_FOUND`, and deletes nothing — not the package,
 * and not the `inquiries` rows that point at it.
 */
export const packageActiveInput = z.object({ id: packageIdSchema, isActive: z.boolean() }).strict();
export type PackageActiveInput = z.infer<typeof packageActiveInput>;

/**
 * One row of `admin.packages.list`.
 *
 * Deliberately NOT a clone of the public `PackageListItem`: this one carries
 * `isActive` (a retired package never reaches a guest, so the admin list is
 * the only place it is visible and therefore the only place it can be switched
 * back on) and `inquiryCount` (how many people have asked about it, which is
 * the number an owner scans this list for), and it types `highlights` properly
 * instead of leaving it `unknown`.
 */
export interface PackageAdminRow {
  id: number;
  slug: string;
  title: string;
  days: number;
  oldPriceCentavos: number | null;
  newPriceCentavos: number;
  description: string | null;
  imagePath: string | null;
  imageAlt: string | null;
  /** Null when the stored JSON is not an array of strings — see the resolver. */
  highlights: string[] | null;
  sortOrder: number;
  seoTitle: string | null;
  seoDescription: string | null;
  ogImage: string | null;
  isActive: boolean;
  /** `COUNT(*)` of `inquiries` rows pointing at this package. */
  inquiryCount: number;
}

/* ----------------------------------------------------------------- Inquiries */

/** `inquiries.type`, mirroring the MySQL enum in `server/src/db/schema.ts`. */
export const INQUIRY_TYPES = ['contact', 'package'] as const;
export type InquiryType = (typeof INQUIRY_TYPES)[number];

/** `inquiries.status`, mirroring the MySQL enum. `new` is where a submission lands. */
export const INQUIRY_STATUSES = ['new', 'read', 'replied', 'closed'] as const;
export type InquiryStatus = (typeof INQUIRY_STATUSES)[number];

/** The words the screen uses for each status, so a test and the UI agree. */
export const INQUIRY_STATUS_LABELS: Record<InquiryStatus, string> = {
  new: 'New',
  read: 'Read',
  replied: 'Replied',
  closed: 'Closed',
};

/**
 * `admin.inquiries.setStatus` — any of the four, including back to `new`.
 *
 * **Why all four, where `reviewStatusInput` excludes `pending`.** A review's
 * `pending` means "no human has looked at this yet", which an admin cannot
 * truthfully re-assert once they have. An enquiry's `new` means something
 * different: "this still needs an answer". That IS a decision an office can
 * legitimately make again — a reply bounced, a guest wrote back, somebody
 * closed the wrong row — and it is the only way the "N waiting" count on the
 * screen can be put right. So the whole enum is settable and every move is
 * reversible.
 *
 * It is a status change and nothing else. There is deliberately no field for a
 * reply: the office answers an enquiry by email or Viber, and a note typed
 * here would be a second, unsent copy of a conversation that happened
 * somewhere else.
 */
export const inquiryStatusInput = z
  .object({
    id: z.number().int().positive(),
    status: z.enum(INQUIRY_STATUSES),
  })
  .strict();
export type InquiryStatusInput = z.infer<typeof inquiryStatusInput>;

/**
 * One enquiry on the admin screen.
 *
 * It carries the guest's name, email, phone and message — which is the whole
 * point of the screen, and why §9 gates it on owner and dispatcher and leaves
 * finance out (RA 10173: admin-only access to personal data, and only the
 * roles whose work needs it). A dispatcher already reads the same three fields
 * on a booking.
 *
 * `packageTitle` is joined when `packageId` is set and null for a general
 * contact-form enquiry, so "enquiry about (nothing)" cannot appear on the
 * screen — the reason `inquiries.package_id` was made a real foreign key.
 */
export interface InquiryAdminRow {
  id: number;
  type: InquiryType;
  status: InquiryStatus;
  /** Null for a general contact-form enquiry. */
  packageId: number | null;
  /** The package's title, or null when there is no package. */
  packageTitle: string | null;
  name: string;
  email: string;
  phone: string | null;
  message: string;
  /** ISO instant. The screen converts to Asia/Manila. */
  createdAt: string;
}

/* -------------------------------------------- The newsletter export (owner) */

/**
 * What `admin.newsletter.export` returns.
 *
 * `csv` is a STRING, not a route — the same shape `admin.reports.csv` uses, and
 * for the same reason: an Express route would need its own copy of the role
 * gate, and that second copy is the one that gets forgotten. The browser wraps
 * it in a `Blob`.
 *
 * `count` is returned as well as being derivable from the file, because it is
 * what the screen says in words after a download and what the audit row
 * records. The addresses are in the file and nowhere else.
 */
export interface NewsletterExport {
  /** `travelsugbo-newsletter-2026-10-27.csv`. */
  filename: string;
  /** A header row and one address per line. */
  csv: string;
  /** How many addresses are in the file. */
  count: number;
}

/** The export's single column heading. */
export const NEWSLETTER_CSV_HEADER = 'Email';
