/**
 * The authenticated receipt routes (Week 4 plan, Tasks 3 and 6).
 *
 *  - `GET /api/receipts/:name` — serves one receipt file.
 *  - `POST /api/receipts/upload` — takes a guest's transfer receipt.
 *
 * Storing receipts outside the web root is only half of CLAUDE.md's rule;
 * the GET is the other half. Without it the files are unreachable, which is
 * secure and useless — a guest cannot see the receipt they uploaded and an
 * admin cannot see the one they are being asked to verify.
 *
 * ## One 404 for every refusal, on the GET
 *
 * No session, a session for a different booking, a receipt that does not
 * exist, a filename that is not even the right shape — all 404, with the
 * same body. Distinguishing them would turn this route into an oracle:
 * "403 Forbidden" means the file exists and belongs to someone else, which
 * is exactly the fact that must not be learnable. The same reasoning §7
 * applies to the login's two wrongs.
 *
 * The UPLOAD is the opposite, and deliberately: the guest is acting on
 * their own booking through their own session, so there is nothing to
 * enumerate, and a generic refusal would leave them re-uploading the same
 * unreadable photograph forever. Every refusal there carries a sentence
 * written for them.
 *
 * ## Who may read a receipt
 *
 *  - the **customer session for that booking** — `subject_id` is the
 *    booking id, so this is an equality check and cannot widen;
 *  - an **owner or finance staff session** — the roles in
 *    `ROLE_MATRIX.verifyPayments`, imported rather than re-listed.
 *
 * **Owner and finance, NOT any staff session** (owner decision 2026-10-23,
 * Q2). It used to be every `subject_type = 'user'` session, reasoning from
 * §9's "Bookings: view, notes ✅ ✅ ✅" row — but a bank transfer screenshot
 * is payment data, and the row that governs payment data is "Verify
 * payments, record payments ✅ ❌ ✅", which is owner and finance. A
 * dispatcher runs the day and never has to decide that money arrived; a
 * guest disputing a transfer at the office is handled by finance or the
 * owner. The dispatcher's refusal is the SAME 404 as a stranger's — see
 * above: narrowing who is admitted must not change what a refusal looks
 * like, or the route becomes the oracle this file exists to keep shut.
 *
 * A driver session may not either. Nothing in §8 needs a guest's bank
 * receipt, and the one thing worse than a receipt nobody can read is one
 * everybody can.
 *
 * **A SUPERSEDED receipt is for those same two roles only** (owner decision
 * 2026-10-14, Q6). It is kept so a disputed transfer can still be examined,
 * and the guest has already moved on to the receipt that replaced it — so
 * the older file stays reachable for the people who verify payments and for
 * nobody else.
 *
 * ## They are Express routes rather than tRPC procedures
 *
 * tRPC answers JSON and carries its arguments in it; these carry FILE BYTES
 * in both directions. A 5MB JPEG base64-encoded into a JSON body is 6.7MB
 * of string that has to be parsed twice, and tRPC's body limit would have
 * to be raised for every procedure to allow it. So the file travels as the
 * raw request body with its metadata in the query string, and both routes
 * read the session cookie themselves through the same `readSession` the
 * context factory uses — one definition of what a session is, two
 * transports.
 */
import express, { Router } from 'express';
import { createReadStream } from 'node:fs';
import { stat, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import { manilaCivilDate, uploadReceiptMetaSchema } from '@rg/shared';
import { readSettingBlock } from '../content/settings';
import { getDb } from '../db/client';
import { bookings, payments, tours } from '../db/schema';
import { ROLE_MATRIX } from '../middleware/require-role';
import { SESSION_COOKIE_BY_SUBJECT } from '../middleware/session-cookie';
import { createReceiptUploadLimiter } from '../middleware/rate-limit';
import { notify } from '../services/notify';
import { ReceiptLimitReachedError, ReceiptNotAcceptedError } from '../services/payments/errors';
import { recordManualReceipt } from '../services/payments/manual-receipt';
import { readSession } from '../services/sessions';
import {
  ALLOWED_RECEIPT_TYPES,
  RECEIPT_MAX_BYTES,
  ReceiptTooLargeError,
  ReceiptTypeNotAllowedError,
  receiptStorageDir,
  storeReceipt,
} from '../services/uploads';

/**
 * Exactly what `storeReceipt()` generates and nothing else: 32 hex
 * characters and one of the four extensions. Anything else is refused
 * before it can reach the filesystem, so `..`, a leading slash, a null byte
 * and a Windows drive letter are all answered by this one regex rather than
 * by trusting `join` to be safe.
 */
const RECEIPT_NAME = /^[0-9a-f]{32}\.(jpg|png|webp|pdf)$/;

const CONTENT_TYPES: Record<string, string> = {
  jpg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
  pdf: 'application/pdf',
};

/**
 * What the guest is told when the bytes are not a receipt. Deliberately
 * specific — "that file is not a photo or a PDF" is actionable, where "bad
 * request" sends them round the loop again — and deliberately not the
 * internal reason, which names the magic bytes we checked.
 */
const TYPE_MESSAGE =
  'Please upload a photo (JPG, PNG or WEBP) or a PDF of your transfer receipt. ' +
  'If you took a screenshot on an iPhone, saving or sharing it as a JPG usually fixes this.';
const SIZE_MESSAGE = 'That file is larger than 5MB. Please upload a smaller photo or screenshot.';

export function createReceiptRouter(): Router {
  const router = Router();

  /**
   * **The upload.** Mounted before the `/:name` GET for clarity only — they
   * differ by method, so the order does not matter to Express here.
   *
   * `express.raw` with an explicit type list, so a body that does not even
   * claim to be one of the four allowed types never reaches a Buffer; and
   * with a size limit, so a 1GB body is refused by the parser rather than
   * buffered into memory and then refused by us. `storeReceipt()` re-checks
   * the size anyway, because the parser's limit is a resource guard and the
   * 5MB rule is a product one.
   */
  router.post(
    '/upload',
    createReceiptUploadLimiter(),
    express.raw({ type: [...ALLOWED_RECEIPT_TYPES], limit: RECEIPT_MAX_BYTES + 1024 }),
    async (req, res) => {
      const refuse = (status: number, message: string) =>
        res.status(status).json({ error: message });

      /*
       * **The booking comes from the SESSION, never from the request.**
       * There is no `bookingId` in the query schema and no way to put one
       * there: a booking id in an upload payload is an IDOR with a form
       * around it. `subject_id` on a customer session IS the booking id.
       */
      const cookies = req.cookies as Record<string, string | undefined> | undefined;
      const token = cookies?.[SESSION_COOKIE_BY_SUBJECT.customer];
      const session = token ? await readSession(token, new Date()) : null;
      if (!session || session.subjectType !== 'customer') {
        return refuse(401, 'Please sign in to your booking again and re-try the upload.');
      }
      const bookingId = session.subjectId;

      const meta = uploadReceiptMetaSchema.safeParse({
        method: req.query.method,
        txnRef: req.query.txnRef,
      });
      if (!meta.success) {
        // The shared schema's own messages are written for guests, so the
        // first one is shown rather than a generic "bad request".
        return refuse(
          400,
          meta.error.issues[0]?.message ?? 'Please check the details and try again.',
        );
      }

      const filename = typeof req.query.filename === 'string' ? req.query.filename : '';
      const body = req.body as unknown;
      if (!Buffer.isBuffer(body) || body.byteLength === 0) return refuse(415, TYPE_MESSAGE);

      let stored: { path: string };
      try {
        stored = await storeReceipt({
          buffer: body,
          mimetype: req.header('content-type') ?? '',
          originalname: filename,
        });
      } catch (error) {
        if (error instanceof ReceiptTooLargeError) return refuse(413, SIZE_MESSAGE);
        if (error instanceof ReceiptTypeNotAllowedError) return refuse(415, TYPE_MESSAGE);
        throw error;
      }

      try {
        await recordManualReceipt({
          bookingId,
          method: meta.data.method,
          txnRef: meta.data.txnRef,
          receiptPath: stored.path,
          now: new Date(),
        });
      } catch (error) {
        /*
         * The file is on disk and the row is not, so the file is removed:
         * an orphan receipt nothing references is a guest's bank statement
         * sitting in a directory with no reason to be there, which is a
         * data-protection problem rather than untidiness (RA 10173).
         *
         * Best-effort and never thrown from: the guest's answer is about
         * their receipt, not about our housekeeping.
         */
        await unlink(join(receiptStorageDir(), stored.path)).catch(() => undefined);

        if (error instanceof ReceiptNotAcceptedError) return refuse(409, error.guestMessage);
        if (error instanceof ReceiptLimitReachedError) return refuse(409, error.guestMessage);
        throw error;
      }

      /*
       * §11, and the rule that it "never blocks the booking flow": both
       * emails are sent AFTER the transaction committed, and `notify()`
       * cannot throw. A mail server that is down must not turn a recorded
       * receipt into an error the guest sees.
       */
      await sendReceiptNotices(bookingId);

      return res.status(200).json({ ok: true, status: 'pending_verification' });
    },
  );

  router.get('/:name', async (req, res) => {
    /** The single refusal. Identical for every reason, deliberately. */
    const refuse = () => res.status(404).json({ error: 'Not found' });

    const name = req.params.name;
    if (!RECEIPT_NAME.test(name)) return refuse();

    /*
     * BUG-119: this route is read by TWO different surfaces — the guest who
     * uploaded the receipt (their own booking) and owner/finance staff
     * (`ROLE_MATRIX.verifyPayments`) — so it is not "single-surface" the way
     * the upload above is. With one shared cookie, whichever subject the
     * cookie resolved to was checked against both the `isVerifier` and
     * `isOwner` rules below and only one could ever be true. Now that each
     * surface has its own cookie, both must be read and resolved
     * independently — reading only one would silently drop the other
     * surface's access.
     */
    const cookies = req.cookies as Record<string, string | undefined> | undefined;
    const customerToken = cookies?.[SESSION_COOKIE_BY_SUBJECT.customer];
    const staffToken = cookies?.[SESSION_COOKIE_BY_SUBJECT.user];
    if (!customerToken && !staffToken) return refuse();

    const now = new Date();
    const customerSession = customerToken ? await readSession(customerToken, now) : null;
    const staffSession = staffToken ? await readSession(staffToken, now) : null;
    if (!customerSession && !staffSession) return refuse();

    const [payment] = await getDb()
      .select({ bookingId: payments.bookingId, status: payments.status })
      .from(payments)
      .where(eq(payments.receiptPath, name))
      .limit(1);
    if (!payment) return refuse();

    /*
     * Owner and finance only, from `ROLE_MATRIX.verifyPayments` rather than
     * a role list written out here — §9's table has one transcription in
     * this codebase and a second copy is how the two drift apart.
     *
     * `some(=== role)` rather than `includes`: `ResolvedSession.role` is a
     * `string | undefined` read live from `users`, and an equality sweep
     * over the allow-list refuses `undefined`, an unrecognised role and
     * `'__proto__'` alike, with no cast asserting what the value is.
     *
     * A staff member still on a temporary password has not finished signing
     * in, so the flag keeps its own clause.
     *
     * Named `isVerifier` and no longer `isStaff`, deliberately: a dispatcher
     * IS staff and this is now false for them, and a flag whose name
     * contradicts its value is the next reader's trap.
     */
    const isVerifier =
      staffSession?.subjectType === 'user' &&
      staffSession.mustChangePassword !== true &&
      ROLE_MATRIX.verifyPayments.some((allowed) => allowed === staffSession.role);
    const isOwner =
      customerSession?.subjectType === 'customer' &&
      customerSession.subjectId === payment.bookingId;
    // A superseded receipt is kept for the people who verify payments. The
    // guest has the one that replaced it; the same 404 as any other
    // stranger's file, so this does not announce that the file exists.
    const ownerMayRead = isOwner && payment.status !== 'superseded';
    if (!isVerifier && !ownerMayRead) return refuse();

    const file = join(receiptStorageDir(), name);
    try {
      await stat(file);
    } catch {
      // The row says there is a receipt and the disk disagrees. Same 404:
      // the guest cannot act on the difference, and the row is the thing to
      // investigate rather than something to announce.
      return refuse();
    }

    const ext = name.slice(name.lastIndexOf('.') + 1);
    res.setHeader('Content-Type', CONTENT_TYPES[ext] ?? 'application/octet-stream');
    /*
     * `nosniff` so a browser cannot be talked into treating a receipt as
     * something executable, and `private, no-store` so a shared proxy never
     * caches another guest's bank transfer screenshot.
     */
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Cache-Control', 'private, no-store');
    createReadStream(file).pipe(res);
    return undefined;
  });

  return router;
}

/**
 * The two §11 emails a receipt triggers: "we have it" to the guest, and
 * "there is one to verify" to the business inbox.
 *
 * The admin address is `settings.contact.email` rather than a new
 * environment variable: it is already the address R&G answer, an admin can
 * change it without a deploy, and the alternative is a second place for the
 * same fact to be wrong.
 *
 * Wrapped in its own try/catch even though `notify()` cannot throw, because
 * the READ before it can — and a database hiccup while fetching a tour
 * title must not fail an upload that is already committed.
 */
async function sendReceiptNotices(bookingId: number): Promise<void> {
  try {
    const [row] = await getDb()
      .select({
        ref: bookings.ref,
        leadEmail: bookings.leadEmail,
        tourTitle: tours.title,
        tourDate: bookings.tourDate,
        totalCentavos: bookings.totalCentavos,
        paidCentavos: bookings.amountPaidCentavos,
      })
      .from(bookings)
      .innerJoin(tours, eq(tours.id, bookings.tourId))
      .where(eq(bookings.id, bookingId))
      .limit(1);
    if (!row) return;

    const payload = {
      ref: row.ref,
      tourTitle: row.tourTitle,
      /*
       * `manilaCivilDate`, not `toISOString().slice(0, 10)`. The column is
       * a DATE read back as midnight in the server's own zone, and on a
       * UTC+8 box that formats as the DAY BEFORE in UTC — a confirmation
       * email telling a guest the wrong tour date. The same helper the
       * checkout and the expiry job use.
       */
      tourDate: manilaCivilDate(row.tourDate),
      totalCentavos: row.totalCentavos,
      paidCentavos: row.paidCentavos,
    };

    await notify('receipt_received', { ...payload, to: row.leadEmail });

    const contact = await readSettingBlock('contact');
    if (contact.email) {
      await notify('admin_receipt_to_verify', { ...payload, to: contact.email });
    }
  } catch (error) {
    const kind = error instanceof Error ? error.name : typeof error;
    console.error(`[receipts] could not send the receipt notices for booking (${kind})`);
  }
}
