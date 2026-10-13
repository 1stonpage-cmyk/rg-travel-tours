/**
 * `GET /api/receipts/:name` — the authenticated route that serves one
 * receipt (Week 4 plan, Task 3).
 *
 * Storing receipts outside the web root is only half of CLAUDE.md's rule;
 * this is the other half. Without it the files are unreachable, which is
 * secure and useless — a guest cannot see the receipt they uploaded and an
 * admin cannot see the one they are being asked to verify.
 *
 * ## One 404 for every refusal
 *
 * No session, a session for a different booking, a receipt that does not
 * exist, a filename that is not even the right shape — all 404, with the
 * same body. Distinguishing them would turn this route into an oracle:
 * "403 Forbidden" means the file exists and belongs to someone else, which
 * is exactly the fact that must not be learnable. The same reasoning §7
 * applies to the login's two wrongs.
 *
 * ## Who may read a receipt
 *
 *  - the **customer session for that booking** — `subject_id` is the
 *    booking id, so this is an equality check and cannot widen;
 *  - any **staff session** (`subject_type = 'user'`), because verifying a
 *    receipt is the admin's job and §9 gives them the bookings area.
 *
 * A driver session may not. Nothing in §8 needs a guest's bank receipt, and
 * the one thing worse than a receipt nobody can read is one everybody can.
 *
 * ## It is an Express route rather than a tRPC procedure
 *
 * tRPC answers JSON; this answers bytes. So it reads the session cookie
 * itself through the same `readSession` the context factory uses — one
 * definition of what a session is, two transports.
 */
import { Router } from 'express';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import { getDb } from '../db/client';
import { payments } from '../db/schema';
import { SESSION_COOKIE } from '../middleware/session-cookie';
import { readSession } from '../services/sessions';
import { receiptStorageDir } from '../services/uploads';

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

export function createReceiptRouter(): Router {
  const router = Router();

  router.get('/:name', async (req, res) => {
    /** The single refusal. Identical for every reason, deliberately. */
    const refuse = () => res.status(404).json({ error: 'Not found' });

    const name = req.params.name;
    if (!RECEIPT_NAME.test(name)) return refuse();

    const cookies = req.cookies as Record<string, string | undefined> | undefined;
    const token = cookies?.[SESSION_COOKIE];
    if (!token) return refuse();

    const session = await readSession(token, new Date());
    if (!session) return refuse();

    const [payment] = await getDb()
      .select({ bookingId: payments.bookingId })
      .from(payments)
      .where(eq(payments.receiptPath, name))
      .limit(1);
    if (!payment) return refuse();

    const isOwner = session.subjectType === 'customer' && session.subjectId === payment.bookingId;
    const isStaff = session.subjectType === 'user';
    if (!isOwner && !isStaff) return refuse();

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
