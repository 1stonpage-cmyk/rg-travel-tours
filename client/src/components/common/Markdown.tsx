import type { ReactNode } from 'react';

/**
 * A deliberately tiny markdown renderer for admin-authored legal copy
 * (`settings.legal.privacy`/`settings.legal.terms`, task 3.6). `react-markdown`
 * is not on the allowed-dependency list, so this exists instead.
 *
 * SECURITY: this is the one hard rule. React elements are built by parsing —
 * `dangerouslySetInnerHTML` is never used, anywhere, in this file. The
 * content is admin-authored today and admin-*editable* from Weeks 5–7, so a
 * renderer that ever turns stored text into raw HTML is a stored-XSS vector
 * sitting behind a login.
 *
 * Supported subset, and nothing else:
 *   - `#`, `##`, `###` headings — ALL of them render as `<h2>` or `<h3>`,
 *     never `<h1>`. A single `#` is deliberately demoted to the same `<h2>`
 *     as `##`, rather than rejected: the page component owns the document's
 *     one real `<h1>`, and that guarantee must hold no matter what an admin
 *     types (one `#`, three, or none) — see the markdown.test.tsx case that
 *     proves a `# Title` line can never produce a second `<h1>`.
 *   - blank-line-separated paragraphs
 *   - `-` bullet lists
 *   - `**bold**`
 *   - `[text](url)` links, scheme-allowlisted (http/https/mailto, or a
 *     same-site path — a leading `/` that is NOT `//`, `///` or `/\`, each
 *     of which the browser resolves to another origin; see `isSameSitePath`)
 *   - `>` blockquotes (the amber TODO-review banner uses this)
 *
 * Everything else — a stray `####`, raw `<script>`/`<img onerror>` HTML,
 * anything that doesn't match one of the patterns above — renders as the
 * literal characters it is. There is no "strip it" behaviour: silently
 * dropping admin-authored text is its own kind of bug (data loss), so
 * anything outside the subset is always shown, just not interpreted.
 */

type Block =
  | { type: 'heading'; level: 2 | 3; text: string }
  | { type: 'paragraph'; text: string }
  | { type: 'list'; items: string[] }
  | { type: 'blockquote'; text: string };

const HEADING_RE = /^#{1,3}(?!#)\s+(.*)$/;
const LEADING_HASHES_RE = /^#+/;
const LIST_ITEM_RE = /^-\s+(.*)$/;
const BLOCKQUOTE_RE = /^>\s?(.*)$/;

function parseBlocks(source: string): Block[] {
  const lines = source.split(/\r?\n/);
  const blocks: Block[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i]!;

    if (line.trim() === '') {
      i += 1;
      continue;
    }

    const heading = HEADING_RE.exec(line);
    if (heading) {
      const hashCount = LEADING_HASHES_RE.exec(line)?.[0].length ?? 1;
      blocks.push({ type: 'heading', level: hashCount >= 3 ? 3 : 2, text: heading[1]!.trim() });
      i += 1;
      continue;
    }

    if (LIST_ITEM_RE.test(line)) {
      const items: string[] = [];
      while (i < lines.length && LIST_ITEM_RE.test(lines[i]!)) {
        items.push(LIST_ITEM_RE.exec(lines[i]!)![1]!);
        i += 1;
      }
      blocks.push({ type: 'list', items });
      continue;
    }

    if (BLOCKQUOTE_RE.test(line)) {
      const quoteLines: string[] = [];
      while (i < lines.length && BLOCKQUOTE_RE.test(lines[i]!)) {
        quoteLines.push(BLOCKQUOTE_RE.exec(lines[i]!)![1]!);
        i += 1;
      }
      blocks.push({ type: 'blockquote', text: quoteLines.join(' ').trim() });
      continue;
    }

    // Paragraph: consume consecutive lines that don't start one of the
    // other block types, joining them with a space.
    const paraLines: string[] = [];
    while (
      i < lines.length &&
      lines[i]!.trim() !== '' &&
      !HEADING_RE.test(lines[i]!) &&
      !LIST_ITEM_RE.test(lines[i]!) &&
      !BLOCKQUOTE_RE.test(lines[i]!)
    ) {
      paraLines.push(lines[i]!);
      i += 1;
    }
    blocks.push({ type: 'paragraph', text: paraLines.join(' ').trim() });
  }

  return blocks;
}

/** http:, https:, mailto:, or a leading "/" same-site path. Nothing else — never javascript:, data:, vbscript:, or any other scheme. */
const ALLOWED_SCHEMES = new Set(['http:', 'https:', 'mailto:']);
const SCHEME_RE = /^([a-zA-Z][a-zA-Z0-9+.-]*):/;

/**
 * A leading "/" is a genuine same-site path ONLY when the next character is
 * not another "/" or a "\". `//evil.com`, `///evil.com` and `/\evil.com`
 * all start with "/" but browsers resolve every one of them as a
 * protocol-relative URL to another origin (`https://evil.com/`) — the
 * earlier `startsWith('/') -> true` shortcut therefore let an admin-
 * authored link point off-site while looking local. Rejecting on the second
 * character fails closed: a same-site path is accepted, anything that could
 * change origin is not.
 */
function isSameSitePath(trimmed: string): boolean {
  if (!trimmed.startsWith('/')) return false;
  const second = trimmed[1];
  return second !== '/' && second !== '\\';
}

function isSafeHref(href: string): boolean {
  const trimmed = href.trim();
  if (trimmed.startsWith('/')) return isSameSitePath(trimmed);
  const match = SCHEME_RE.exec(trimmed);
  if (!match) return false;
  return ALLOWED_SCHEMES.has(`${match[1]!.toLowerCase()}:`);
}

const INLINE_RE = /\*\*(.+?)\*\*|\[([^\]]*)\]\(([^)]+)\)/g;

/**
 * Parses `**bold**` and `[text](url)` inside one block's text. Everything
 * else — including anything that merely looks like HTML or markdown — is
 * emitted as a plain string, which React renders as an escaped text node,
 * never as markup.
 */
function renderInline(text: string, keyPrefix: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  const pattern = new RegExp(INLINE_RE);
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  let i = 0;

  while ((match = pattern.exec(text)) !== null) {
    if (match.index > lastIndex) {
      nodes.push(text.slice(lastIndex, match.index));
    }

    const [whole, boldText, linkText, linkHref] = match;
    if (boldText !== undefined) {
      nodes.push(<strong key={`${keyPrefix}-${i}`}>{boldText}</strong>);
    } else if (linkHref !== undefined && isSafeHref(linkHref)) {
      const trimmedHref = linkHref.trim();
      const isExternal = /^https?:/i.test(trimmedHref);
      // `target="_blank"` stays http(s)-only (a mailto: or same-site link
      // has no business opening a tab), but `rel="noopener noreferrer"`
      // goes on everything that is not a same-site path — anything leaving
      // this origin, mailto: included — rather than only on http(s).
      const sameSite = isSameSitePath(trimmedHref);
      nodes.push(
        <a
          key={`${keyPrefix}-${i}`}
          href={linkHref}
          className="text-brand-blue-700 underline underline-offset-2 hover:no-underline"
          {...(isExternal ? { target: '_blank' } : {})}
          {...(sameSite ? {} : { rel: 'noopener noreferrer' })}
        >
          {linkText}
        </a>,
      );
    } else {
      // Disallowed scheme (javascript:, data:, vbscript:, …) — no link is
      // produced at all, not even with the href stripped. The whole
      // `[text](url)` span renders as literal text.
      nodes.push(whole);
    }

    lastIndex = match.index + whole.length;
    i += 1;
  }

  if (lastIndex < text.length) {
    nodes.push(text.slice(lastIndex));
  }

  return nodes;
}

export default function Markdown({ source }: { source: string }) {
  const blocks = parseBlocks(source);

  return (
    <>
      {blocks.map((block, index) => {
        const key = `block-${index}`;

        switch (block.type) {
          case 'heading': {
            const HeadingTag = block.level === 3 ? 'h3' : 'h2';
            return (
              <HeadingTag
                key={key}
                className={
                  block.level === 3
                    ? 'text-brand-blue-900 mt-6 text-lg font-bold'
                    : 'text-brand-blue-900 mt-8 text-xl font-bold'
                }
              >
                {renderInline(block.text, key)}
              </HeadingTag>
            );
          }
          case 'list':
            return (
              <ul key={key} className="mt-4 list-disc space-y-1 pl-6">
                {block.items.map((item, itemIndex) => (
                  <li key={`${key}-${itemIndex}`}>{renderInline(item, `${key}-${itemIndex}`)}</li>
                ))}
              </ul>
            );
          case 'blockquote':
            // The amber "TODO: client legal review" warning style. See
            // BUG-080: `text-brand-warning` on `bg-brand-gold-100` measures
            // 4.51:1 — AA pass with zero headroom. `text-brand-gold-800` on
            // the same background measures 7.45:1, so that pairing is used
            // here instead.
            return (
              <blockquote
                key={key}
                className="border-brand-warning/50 bg-brand-gold-100 text-brand-gold-800 mt-6 rounded-md border-l-4 px-4 py-3 text-sm font-medium"
              >
                {renderInline(block.text, key)}
              </blockquote>
            );
          case 'paragraph':
          default:
            return (
              <p key={key} className="mt-4 leading-relaxed">
                {renderInline(block.text, key)}
              </p>
            );
        }
      })}
    </>
  );
}
