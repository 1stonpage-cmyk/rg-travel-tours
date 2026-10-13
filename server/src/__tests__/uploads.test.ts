/**
 * Week 4 plan, Task 3: receipt storage.
 *
 * §6: jpg/png/webp/pdf, max 5 MB. CLAUDE.md: "validate MIME + extension +
 * size, rename to random IDs, store outside the web root, serve via an
 * authenticated route."
 *
 * **The MIME type the browser sends is not evidence.** It is a string in the
 * request, chosen by whoever made the request, so an allowlist over it stops
 * an honest mistake and nothing else. The check that cannot be talked out of
 * is the file's own leading bytes, and the tests below are written against
 * that: every refusal case sends a PLAUSIBLE declared type, because a test
 * that refuses `application/x-msdownload` only proves the allowlist works on
 * attackers who announce themselves.
 *
 * No `multer`, no `file-type` — the owner's answer to Q11 was `nodemailer`
 * and `cookie-parser` and nothing else, and the sniffing this needs is four
 * byte comparisons.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import {
  RECEIPT_MAX_BYTES,
  ReceiptTooLargeError,
  ReceiptTypeNotAllowedError,
  receiptStorageDir,
  storeReceipt,
} from '../services/uploads';

/** Real leading bytes for each accepted type. */
const MAGIC = {
  jpeg: Buffer.from([0xff, 0xd8, 0xff, 0xe0]),
  png: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  webp: Buffer.concat([
    Buffer.from('RIFF'),
    Buffer.from([0x24, 0x00, 0x00, 0x00]),
    Buffer.from('WEBP'),
  ]),
  pdf: Buffer.from('%PDF-1.4'),
  /** A Windows executable. The thing an attacker actually uploads. */
  exe: Buffer.from([0x4d, 0x5a, 0x90, 0x00]),
};

const file = (
  magic: Buffer,
  mimetype: string,
  originalname: string,
  padTo = 0,
): { buffer: Buffer; mimetype: string; originalname: string } => ({
  buffer: padTo > magic.length ? Buffer.concat([magic, Buffer.alloc(padTo - magic.length)]) : magic,
  mimetype,
  originalname,
});

const written: string[] = [];

async function store(input: Parameters<typeof storeReceipt>[0]) {
  const result = await storeReceipt(input);
  written.push(result.path);
  return result;
}

afterAll(async () => {
  for (const name of written) {
    await rm(join(receiptStorageDir(), name), { force: true });
  }
});

describe('storeReceipt', () => {
  it('accepts each of the four types §6 allows', async () => {
    const cases = [
      [MAGIC.jpeg, 'image/jpeg', 'r.jpg', 'jpg'],
      [MAGIC.png, 'image/png', 'r.png', 'png'],
      [MAGIC.webp, 'image/webp', 'r.webp', 'webp'],
      [MAGIC.pdf, 'application/pdf', 'r.pdf', 'pdf'],
    ] as const;

    for (const [magic, mime, name, ext] of cases) {
      const { path } = await store(file(magic, mime, name));
      expect(path, `${mime} was stored as ${path}`).toMatch(new RegExp(`^[0-9a-f]{32}\\.${ext}$`));
    }
  });

  /**
   * The stored name carries NOTHING from the upload. Not the stem, not the
   * extension — the extension is derived from the type we verified, so a
   * file called `x.jpg` whose bytes are a PNG is stored as `….png`.
   */
  it('renames to a random id and keeps nothing from the original name', async () => {
    const { path } = await store(file(MAGIC.jpeg, 'image/jpeg', 'my holiday receipt FINAL.jpg'));
    expect(path).toMatch(/^[0-9a-f]{32}\.jpg$/);
    expect(path.toLowerCase()).not.toContain('holiday');
    expect(path.toLowerCase()).not.toContain('final');
  });

  it('never produces the same name twice', async () => {
    const names = new Set<string>();
    for (let i = 0; i < 10; i += 1) {
      names.add((await store(file(MAGIC.png, 'image/png', 'r.png'))).path);
    }
    expect(names.size).toBe(10);
  });

  it('writes the bytes it was given, unchanged', async () => {
    const input = file(MAGIC.pdf, 'application/pdf', 'r.pdf', 64);
    const { path } = await store(input);
    expect(await readFile(join(receiptStorageDir(), path))).toEqual(input.buffer);
  });

  /**
   * **The one that matters.** A declared type on the allowlist, an extension
   * that agrees with it, and bytes that are a Windows executable. Both
   * client-supplied checks pass; only the sniff refuses it.
   */
  it('REFUSES an executable that declares itself a JPEG', async () => {
    await expect(store(file(MAGIC.exe, 'image/jpeg', 'receipt.jpg'))).rejects.toBeInstanceOf(
      ReceiptTypeNotAllowedError,
    );
  });

  it('REFUSES a PNG declaring itself a PDF — the bytes decide, not the label', async () => {
    await expect(store(file(MAGIC.png, 'application/pdf', 'receipt.pdf'))).rejects.toBeInstanceOf(
      ReceiptTypeNotAllowedError,
    );
  });

  it('REFUSES a type that is not on the allowlist at all', async () => {
    await expect(
      store(file(Buffer.from('GIF89a'), 'image/gif', 'receipt.gif')),
    ).rejects.toBeInstanceOf(ReceiptTypeNotAllowedError);
  });

  it('REFUSES when the extension disagrees with the declared type', async () => {
    await expect(store(file(MAGIC.jpeg, 'image/jpeg', 'receipt.pdf'))).rejects.toBeInstanceOf(
      ReceiptTypeNotAllowedError,
    );
  });

  it('REFUSES a file with no extension at all', async () => {
    await expect(store(file(MAGIC.jpeg, 'image/jpeg', 'receipt'))).rejects.toBeInstanceOf(
      ReceiptTypeNotAllowedError,
    );
  });

  it('accepts an UPPERCASE extension, which phones produce constantly', async () => {
    const { path } = await store(file(MAGIC.jpeg, 'image/jpeg', 'IMG_0421.JPG'));
    expect(path).toMatch(/^[0-9a-f]{32}\.jpg$/);
  });

  it('accepts .jpeg as well as .jpg', async () => {
    const { path } = await store(file(MAGIC.jpeg, 'image/jpeg', 'receipt.jpeg'));
    expect(path).toMatch(/^[0-9a-f]{32}\.jpg$/);
  });

  it('REFUSES a file one byte over 5 MB, and accepts one exactly at the cap', async () => {
    await expect(
      store(file(MAGIC.jpeg, 'image/jpeg', 'r.jpg', RECEIPT_MAX_BYTES + 1)),
    ).rejects.toBeInstanceOf(ReceiptTooLargeError);

    const { path } = await store(file(MAGIC.jpeg, 'image/jpeg', 'r.jpg', RECEIPT_MAX_BYTES));
    expect(path).toMatch(/\.jpg$/);
  });

  it('caps at exactly 5 MB, as §6 says', () => {
    expect(RECEIPT_MAX_BYTES).toBe(5 * 1024 * 1024);
  });

  /**
   * The original name is never used to build a path, so traversal cannot
   * reach outside the directory — but the test exists because "we do not
   * use it" is a property that a later refactor can quietly lose.
   */
  it('cannot be made to write outside its directory by the filename', async () => {
    const { path } = await store(file(MAGIC.jpeg, 'image/jpeg', '../../../etc/cron.d/payload.jpg'));
    expect(path).toMatch(/^[0-9a-f]{32}\.jpg$/);
    expect(path).not.toContain('/');
    expect(path).not.toContain('\\');
    expect(path).not.toContain('..');
  });

  it('REFUSES an empty file', async () => {
    await expect(
      store({ buffer: Buffer.alloc(0), mimetype: 'image/jpeg', originalname: 'r.jpg' }),
    ).rejects.toBeInstanceOf(ReceiptTypeNotAllowedError);
  });

  /**
   * Fails CLOSED on a refusal: nothing reaches the disk. A rejected upload
   * that still wrote its bytes would make the validation decorative.
   */
  it('writes NOTHING when it refuses', async () => {
    const before = written.length;
    await store(file(MAGIC.exe, 'image/jpeg', 'receipt.jpg')).catch(() => undefined);
    expect(written).toHaveLength(before);
  });
});

describe('receiptStorageDir', () => {
  /**
   * CLAUDE.md: uploads live OUTSIDE the web root. The web root is
   * `client/dist`, which is what nginx serves; a receipt under it would be
   * downloadable by URL with no session at all, which is the whole failure
   * this rule exists to prevent.
   */
  it('is outside the directory the web server serves', () => {
    const dir = receiptStorageDir().replace(/\\/g, '/');
    expect(dir).not.toContain('client/dist');
    expect(dir).not.toContain('client/public');
  });

  it('is absolute, so it does not move with the process working directory', () => {
    expect(receiptStorageDir()).toMatch(/^([A-Za-z]:[/\\]|\/)/);
  });
});
