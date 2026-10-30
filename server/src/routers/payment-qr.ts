/**
 * `GET /api/payment-qr` — the R&G payment QR image (Week 4 plan, Task 8).
 *
 * **It takes no parameter**, and that is the whole of its traversal
 * defence: there is exactly one QR, its filename comes from the
 * `payment_qr` settings block, and nothing a caller sends reaches the
 * filesystem. The receipts route has to accept a name and therefore has to
 * police it with a regex; this one never does.
 *
 * ## Who may see it
 *
 * A signed-in guest (a `customer` session) or any staff session. Not the
 * public internet: the owner's Q5 decision is that the manual-transfer
 * details — account name, number and this image — are behind the guest
 * session, and a QR that anyone could fetch would be the account number in
 * picture form. Not a driver either, for the same reason they cannot read a
 * receipt.
 *
 * ## One 404 for everything
 *
 * No session, a driver session, an unconfigured block, a configured block
 * whose file is missing: all 404, same body. There is nothing a caller can
 * learn about whether R&G have set up their QR yet.
 *
 * `POST /api/payment-qr/upload` — owner decision 2026-10-28: R&G's owner has
 * no way to copy a file onto the server, so the settings screen's "QR image
 * path" text field is replaced by an upload. Owner only — the same
 * `ROLE_MATRIX.usersSettings` gate `admin.settings.write` uses for this
 * block — reusing `storeReceipt`'s own safeguards (`storeQrImage`, in
 * `services/uploads.ts`): declared MIME, extension, size and the file's own
 * leading bytes, restricted to the three image types (no PDF — a QR is
 * always an image), a random filename, written to `paymentQrStorageDir()`.
 * The OLD file is kept, never deleted: `settings.payment_qr.imagePath` is
 * just repointed at the new one. One `audit_log` row names the actor and
 * both filenames — unlike `writeSettingBlock`'s generic `setting.updated`
 * (which deliberately never logs a `payment_qr` value, because
 * `accountNumber` is where a guest's money goes), a filename is not account
 * data, and an owner asking "which file replaced which, and when" needs it.
 * So this writes its own row directly, through the one validator
 * (`SETTING_SCHEMAS.payment_qr`) and bypassing `writeSettingBlock` to avoid a
 * second, redundant audit row for the same change.
 */
import express, { Router } from 'express';
import { createReadStream } from 'node:fs';
import { stat, unlink } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import { eq } from 'drizzle-orm';
import { readSettingBlock } from '../content/settings';
import { SETTING_SCHEMAS } from '../content/settings-schema';
import { SETTING_AUDIT_ENTITY, SETTING_AUDIT_ENTITY_ID } from '../content/settings-write';
import { getDb } from '../db/client';
import { settings } from '../db/schema';
import { env } from '../env';
import { ROLE_MATRIX } from '../middleware/require-role';
import { SESSION_COOKIE_BY_SUBJECT } from '../middleware/session-cookie';
import { writeAudit } from '../services/audit';
import { readSession } from '../services/sessions';
import {
  ALLOWED_QR_TYPES,
  RECEIPT_MAX_BYTES,
  ReceiptTooLargeError,
  ReceiptTypeNotAllowedError,
  storeQrImage,
} from '../services/uploads';

/**
 * Where the QR image lives: a sibling of the receipts directory, under the
 * same `UPLOADS_DIR` that is OUTSIDE the web root. Absolute, for the reason
 * `receiptStorageDir()` sets out — a relative path means a different
 * directory depending on who started the process.
 */
export function paymentQrStorageDir(): string {
  const configured = env.UPLOADS_DIR;
  const base = isAbsolute(configured) ? configured : resolve(process.cwd(), '..', configured);
  return join(base, 'payment-qr');
}

/** The image types an admin may set as the QR. */
const CONTENT_TYPES: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
};

/**
 * The stored filename, which is admin-set rather than generated, so it is
 * still checked: one path segment, no separators, no dots beyond the
 * extension. Defence in depth — the value comes from a settings row that
 * only an admin can write, and a settings row is not a reason to hand
 * `join` whatever it contains.
 */
const QR_NAME = /^[A-Za-z0-9][A-Za-z0-9_-]{0,80}\.(png|jpg|jpeg|webp)$/;

/** What the owner is told when the upload is not one of the three image types. */
const TYPE_MESSAGE = 'Please upload a photo of the QR as a JPG, PNG or WEBP.';
const SIZE_MESSAGE = 'That image is larger than 5MB. Please upload a smaller file.';

export function createPaymentQrRouter(): Router {
  const router = Router();

  /**
   * **The upload.** Mounted before the `GET /` for clarity only — different
   * methods, so the order does not matter to Express here. Same shape as
   * `POST /api/receipts/upload`: the file as the raw body, its original
   * name in the query string so the extension can be checked against the
   * sniffed type.
   */
  router.post(
    '/upload',
    express.raw({ type: [...ALLOWED_QR_TYPES], limit: RECEIPT_MAX_BYTES + 1024 }),
    async (req, res) => {
      const refuse = (status: number, message: string) =>
        res.status(status).json({ error: message });

      const cookies = req.cookies as Record<string, string | undefined> | undefined;
      const token = cookies?.[SESSION_COOKIE_BY_SUBJECT.user];
      const session = token ? await readSession(token, new Date()) : null;
      if (!session || session.subjectType !== 'user') {
        return refuse(401, 'Please sign in again and retry the upload.');
      }
      // A staff member still on a temporary password has not finished signing in.
      if (session.mustChangePassword === true) {
        return refuse(401, 'Please sign in again and retry the upload.');
      }
      if (!ROLE_MATRIX.usersSettings.some((allowed) => allowed === session.role)) {
        return refuse(403, 'Only the owner can change the payment QR.');
      }

      const filename = typeof req.query.filename === 'string' ? req.query.filename : '';
      const body = req.body as unknown;
      if (!Buffer.isBuffer(body) || body.byteLength === 0) return refuse(415, TYPE_MESSAGE);

      let stored: { path: string };
      try {
        stored = await storeQrImage(
          { buffer: body, mimetype: req.header('content-type') ?? '', originalname: filename },
          paymentQrStorageDir(),
        );
      } catch (error) {
        if (error instanceof ReceiptTooLargeError) return refuse(413, SIZE_MESSAGE);
        if (error instanceof ReceiptTypeNotAllowedError) return refuse(415, TYPE_MESSAGE);
        throw error;
      }

      // From here, the file is on disk: every exit below that does not
      // commit the row removes it, so a refused or failed save never leaves
      // an orphan image.
      const removeStored = () =>
        unlink(join(paymentQrStorageDir(), stored.path)).catch(() => undefined);

      const current = await readSettingBlock('payment_qr');
      const parsed = SETTING_SCHEMAS.payment_qr.safeParse({
        ...current,
        imagePath: stored.path,
      });
      if (!parsed.success) {
        await removeStored();
        return refuse(400, 'The QR could not be saved. Please try again.');
      }

      try {
        await getDb().transaction(async (tx) => {
          await tx
            .update(settings)
            .set({ value: parsed.data, updatedAt: new Date() })
            .where(eq(settings.key, 'payment_qr'));

          await writeAudit(tx, {
            actorType: 'user',
            actorId: session.subjectId,
            action: 'payment_qr.image_uploaded',
            entity: SETTING_AUDIT_ENTITY,
            entityId: SETTING_AUDIT_ENTITY_ID,
            data: { oldImagePath: current.imagePath, newImagePath: stored.path },
          });
        });
      } catch (error) {
        await removeStored();
        throw error;
      }

      return res.status(200).json({ ok: true, imagePath: stored.path });
    },
  );

  router.get('/', async (req, res) => {
    /** The single refusal. Identical for every reason. */
    const refuse = () => res.status(404).json({ error: 'Not found' });

    /*
     * BUG-119: this route is read by TWO different surfaces — a signed-in
     * guest viewing the manual-payment QR and any staff session — so, like
     * `receipts.ts`'s GET, it is not "single-surface" the way the upload
     * above is. Both cookies are read and resolved independently; reading
     * only one would silently drop the other surface's access.
     */
    const cookies = req.cookies as Record<string, string | undefined> | undefined;
    const customerToken = cookies?.[SESSION_COOKIE_BY_SUBJECT.customer];
    const staffToken = cookies?.[SESSION_COOKIE_BY_SUBJECT.user];
    if (!customerToken && !staffToken) return refuse();

    const now = new Date();
    const customerSession = customerToken ? await readSession(customerToken, now) : null;
    const staffSession = staffToken ? await readSession(staffToken, now) : null;

    const isCustomer = customerSession?.subjectType === 'customer';
    // A staff member still on a temporary password has not finished signing in.
    const isStaff =
      staffSession?.subjectType === 'user' && staffSession.mustChangePassword !== true;
    if (!isCustomer && !isStaff) return refuse();

    const qr = await readSettingBlock('payment_qr');
    if (!qr.isConfigured || !qr.imagePath || !QR_NAME.test(qr.imagePath)) return refuse();

    const file = join(paymentQrStorageDir(), qr.imagePath);
    try {
      await stat(file);
    } catch {
      // The settings row says there is an image and the disk disagrees. The
      // row is the thing to investigate; the guest cannot act on it.
      return refuse();
    }

    const ext = qr.imagePath.slice(qr.imagePath.lastIndexOf('.') + 1).toLowerCase();
    res.setHeader('Content-Type', CONTENT_TYPES[ext] ?? 'application/octet-stream');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    /*
     * `private` so no shared proxy keeps it, but cacheable in the guest's
     * own browser for an hour: it is the same image on every visit and a
     * guest on a Cebu mobile connection should not re-download it each time
     * they re-check their booking.
     */
    res.setHeader('Cache-Control', 'private, max-age=3600');
    createReadStream(file).pipe(res);
    return undefined;
  });

  return router;
}
