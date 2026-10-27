/**
 * Receipt storage (Week 4 plan, Task 3) — §6's "jpg/png/webp/pdf, max 5 MB",
 * and CLAUDE.md's upload rules: validate MIME + extension + size, rename to
 * a random id, store outside the web root, serve via an authenticated route.
 *
 * ## The declared MIME type is not evidence
 *
 * `file.mimetype` is a string in the request, chosen by whoever sent it. An
 * allowlist over it stops an honest mistake — a guest picking a `.docx` —
 * and stops nothing else, because an attacker simply declares `image/jpeg`.
 * So all three client-supplied facts are checked (type, extension, size) and
 * then the only fact the client does not control is checked too: **the
 * file's own leading bytes.** A Windows executable declaring itself a JPEG
 * with a `.jpg` name passes every other test and fails that one.
 *
 * Four byte comparisons, no dependency. The owner's answer to Q11 was
 * `nodemailer` and `cookie-parser` and nothing else, and `file-type` would
 * be a package for something that fits in a switch statement.
 *
 * ## The stored name carries nothing from the upload
 *
 * 16 random bytes as hex, plus an extension derived from the type that was
 * VERIFIED — never from the uploaded filename. Three things follow, and the
 * third is the one people forget:
 *
 *  1. Path traversal is impossible, because no part of the guest's string
 *     reaches the path.
 *  2. A receipt cannot be guessed by URL, because the name is 128 bits of
 *     randomness rather than `receipt-RG-7KQ4M9.jpg`.
 *  3. The extension cannot lie about the content, because it is derived from
 *     the sniff: a file named `x.jpg` whose bytes are a PNG is stored as
 *     `….png`, so whatever later serves it with a `Content-Type` from the
 *     extension tells the truth.
 *
 * ## Outside the web root, always
 *
 * `UPLOADS_DIR` defaults to `./uploads` at the repo root, and the web root
 * is `client/dist`. A receipt under the web root would be fetchable by URL
 * with no session at all — which is the entire failure this rule exists to
 * prevent, and why a test asserts the resolved directory is not under it.
 */
import { randomBytes } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import { env } from '../env';

/** §6: "max 5 MB". */
export const RECEIPT_MAX_BYTES = 5 * 1024 * 1024;

/** The receipt is bigger than §6 allows. */
export class ReceiptTooLargeError extends Error {
  readonly sizeBytes: number;

  constructor(sizeBytes: number) {
    super(`Receipt is ${sizeBytes} bytes; the limit is ${RECEIPT_MAX_BYTES}`);
    this.name = 'ReceiptTooLargeError';
    this.sizeBytes = sizeBytes;
  }
}

/**
 * The file is not one of §6's four types — by declared type, by extension,
 * or by its actual bytes.
 *
 * ONE error for all three, deliberately: a guest cannot act differently on
 * "your extension disagrees with your content type" than on "that is not an
 * image", and an attacker should not be told which of our checks caught
 * them. The reason is carried for the server log, never for the response.
 */
export class ReceiptTypeNotAllowedError extends Error {
  readonly detail: string;

  constructor(detail: string) {
    super('Receipt must be a JPG, PNG, WEBP or PDF');
    this.name = 'ReceiptTypeNotAllowedError';
    this.detail = detail;
  }
}

/** §6's four types, each with the extensions it may arrive under and its signature. */
const ALLOWED = [
  {
    mime: 'image/jpeg',
    /** Stored extension. */
    ext: 'jpg',
    accepts: ['jpg', 'jpeg'],
    /** JPEG: FF D8 FF. */
    matches: (b: Buffer) => b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff,
  },
  {
    mime: 'image/png',
    ext: 'png',
    accepts: ['png'],
    /** PNG: 89 50 4E 47 0D 0A 1A 0A. */
    matches: (b: Buffer) =>
      b.length >= 8 &&
      b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
  },
  {
    mime: 'image/webp',
    ext: 'webp',
    accepts: ['webp'],
    /** WEBP: `RIFF` then four size bytes then `WEBP`. */
    matches: (b: Buffer) =>
      b.length >= 12 &&
      b.subarray(0, 4).toString('latin1') === 'RIFF' &&
      b.subarray(8, 12).toString('latin1') === 'WEBP',
  },
  {
    mime: 'application/pdf',
    ext: 'pdf',
    accepts: ['pdf'],
    /** PDF: `%PDF-`. */
    matches: (b: Buffer) => b.length >= 5 && b.subarray(0, 5).toString('latin1') === '%PDF-',
  },
] as const;

export const ALLOWED_RECEIPT_TYPES = ALLOWED.map((a) => a.mime);

/** The three image types a payment QR may be uploaded as — no PDF. */
const QR_ALLOWED = ALLOWED.filter((a) => a.mime !== 'application/pdf');

export const ALLOWED_QR_TYPES = QR_ALLOWED.map((a) => a.mime);

/**
 * Where receipts live, resolved to an absolute path once.
 *
 * Absolute because a relative `UPLOADS_DIR` would otherwise mean different
 * directories depending on the process's working directory — the server
 * started by PM2 from `/`, a test run from `server/`, a script run from the
 * repo root would each write somewhere different, and a receipt saved in one
 * would 404 from another.
 */
export function receiptStorageDir(): string {
  const configured = env.UPLOADS_DIR;
  const base = isAbsolute(configured) ? configured : resolve(process.cwd(), '..', configured);
  return join(base, 'receipts');
}

/** The extension of a filename, lowercased, or `null` if it has none. */
function extensionOf(filename: string): string | null {
  const dot = filename.lastIndexOf('.');
  if (dot === -1 || dot === filename.length - 1) return null;
  return filename.slice(dot + 1).toLowerCase();
}

/**
 * Validates and stores one upload against a given set of allowed types and
 * directory, returning the generated filename. Shared by `storeReceipt` and
 * `storeQrImage` — same four checks, same random-name guarantee, different
 * allow-list and destination.
 *
 * The order of the checks is deliberate: **size first**, because it is the
 * cheapest and the only one whose failure means we should not be looking at
 * the bytes at all. Then the declared type, then the extension against that
 * type, then the signature. Every one of them must pass; nothing is written
 * until all four have.
 */
async function storeUpload(
  input: { buffer: Buffer; mimetype: string; originalname: string },
  opts: { allowed: readonly (typeof ALLOWED)[number][]; maxBytes: number; dir: string },
): Promise<{ path: string }> {
  if (input.buffer.byteLength > opts.maxBytes) {
    throw new ReceiptTooLargeError(input.buffer.byteLength);
  }

  const allowed = opts.allowed.find((a) => a.mime === input.mimetype.toLowerCase());
  if (!allowed) throw new ReceiptTypeNotAllowedError(`declared type ${input.mimetype}`);

  const ext = extensionOf(input.originalname);
  if (!ext) throw new ReceiptTypeNotAllowedError('no extension');
  if (!allowed.accepts.includes(ext as never)) {
    throw new ReceiptTypeNotAllowedError(`extension .${ext} does not match ${allowed.mime}`);
  }

  /*
   * The check the client cannot talk its way past. Everything above this
   * line is a claim made by the uploader; this is the file itself.
   */
  if (!allowed.matches(input.buffer)) {
    throw new ReceiptTypeNotAllowedError(`bytes are not ${allowed.mime}`);
  }

  await mkdir(opts.dir, { recursive: true });

  // 16 bytes = 128 bits: unguessable, so the filename is not a credential
  // anyone can enumerate even before the authenticated route refuses them.
  const name = `${randomBytes(16).toString('hex')}.${allowed.ext}`;
  await writeFile(join(opts.dir, name), input.buffer);

  return { path: name };
}

/** Validates and stores one receipt, returning the generated filename. */
export async function storeReceipt(input: {
  buffer: Buffer;
  mimetype: string;
  originalname: string;
}): Promise<{ path: string }> {
  return storeUpload(input, {
    allowed: ALLOWED,
    maxBytes: RECEIPT_MAX_BYTES,
    dir: receiptStorageDir(),
  });
}

/**
 * Validates and stores one payment QR image — the same four checks as a
 * receipt, restricted to PNG/JPG/WEBP (no PDF: a QR is always an image), and
 * written to `dir` rather than `receiptStorageDir()`.
 */
export async function storeQrImage(
  input: { buffer: Buffer; mimetype: string; originalname: string },
  dir: string,
): Promise<{ path: string }> {
  return storeUpload(input, { allowed: QR_ALLOWED, maxBytes: RECEIPT_MAX_BYTES, dir });
}
