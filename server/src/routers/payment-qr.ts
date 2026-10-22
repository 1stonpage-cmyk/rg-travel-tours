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
 */
import { Router } from 'express';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import { readSettingBlock } from '../content/settings';
import { env } from '../env';
import { SESSION_COOKIE } from '../middleware/session-cookie';
import { readSession } from '../services/sessions';

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

export function createPaymentQrRouter(): Router {
  const router = Router();

  router.get('/', async (req, res) => {
    /** The single refusal. Identical for every reason. */
    const refuse = () => res.status(404).json({ error: 'Not found' });

    const cookies = req.cookies as Record<string, string | undefined> | undefined;
    const token = cookies?.[SESSION_COOKIE];
    if (!token) return refuse();

    const session = await readSession(token, new Date());
    if (!session) return refuse();
    if (session.subjectType !== 'customer' && session.subjectType !== 'user') return refuse();
    // A staff member still on a temporary password has not finished signing in.
    if (session.mustChangePassword === true) return refuse();

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
