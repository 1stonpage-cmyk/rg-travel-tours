/**
 * Manual transfer receipts — the shared half (BUILD_SPEC §6, Week 4 Task 6).
 *
 * The guest pays by GCash, Maya or bank transfer, types the reference their
 * app gave them, and uploads a screenshot. These are the values the browser
 * is allowed to send, and they live in `/shared` because the client builds
 * the form from them and the server refuses anything else — one list, so
 * the two cannot drift into a form offering a method the server rejects.
 *
 * **What is NOT here: the amount.** The server computes what is owed from
 * the booking (CLAUDE.md: "the server computes all money"), so there is no
 * schema for a guest-entered amount and therefore no field a browser could
 * put one in.
 */
import { z } from 'zod';

/**
 * The instruments a guest may pick for a manual transfer (owner decision
 * 2026-10-14, Q4).
 *
 * A strict subset of the database's `PAYMENT_METHODS`, and deliberately so:
 * `card`, `grab_pay` and `qrph` belong to the gateway, which issues its own
 * payment and its own webhook, and `cash` is the office-or-driver flow in
 * §8. None of the four is something a guest uploads a receipt for, so all
 * four are refused at this boundary rather than later.
 */
export const MANUAL_TRANSFER_METHODS = ['gcash', 'maya', 'bank_transfer'] as const;
export type ManualTransferMethod = (typeof MANUAL_TRANSFER_METHODS)[number];
export const manualTransferMethodSchema = z.enum(MANUAL_TRANSFER_METHODS);

/**
 * Five receipts per booking, then a human takes over (owner decision
 * 2026-10-14, Q6).
 *
 * This is a cap on ROWS, not a rate limit: the per-IP upload limit stops a
 * flood, and this stops a patient guest re-uploading forty times and
 * burying the one receipt an admin needs to look at.
 */
export const RECEIPT_UPLOAD_MAX_PER_BOOKING = 5;

/**
 * What the guest is told at the cap — amber, never red, and it ends with a
 * way forward rather than a dead stop (owner decision 2026-10-14).
 */
export const RECEIPT_CAP_MESSAGE =
  'You have already uploaded five receipts for this booking, which is the most we can accept here. ' +
  'Please message us and we will sort it out with you directly.';

/**
 * The reference the guest's banking or e-wallet app gave them.
 *
 * Bounded and printable rather than pattern-matched to a provider: a GCash
 * reference is thirteen digits, a bank's is whatever that bank prints, and
 * a regex tight enough to prove one would refuse the next. The admin reads
 * it against the uploaded receipt in Task 7, which is the real check — this
 * only keeps the column sane and refuses a payload with control characters
 * or a novel in it.
 */
export const transferReferenceSchema = z
  .string()
  .trim()
  .min(4, 'Please enter the reference number from your transfer.')
  .max(80)
  .regex(/^[\x20-\x7E]+$/, 'Please use only the characters your transfer receipt shows.');

/**
 * Everything the browser sends ALONGSIDE the file. Not the booking id: the
 * server reads that from the session, because a booking id in an upload
 * payload is an IDOR with a form around it.
 */
export const uploadReceiptMetaSchema = z
  .object({ method: manualTransferMethodSchema, txnRef: transferReferenceSchema })
  .strict();
export type UploadReceiptMeta = z.infer<typeof uploadReceiptMetaSchema>;
