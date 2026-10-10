/**
 * Injects a resolved `PageMeta` into the built (or dev-transformed) index.html.
 *
 * Pure string work, no database and no Express — so the production handler
 * (server/src/html.ts) and the dev middleware (client/vite.config.ts) produce
 * byte-identical heads from the same meta (plan decision D6), and so this
 * module's tests need no fixtures.
 *
 * SECURITY: every value interpolated here comes from the database and is
 * therefore admin-editable content, which is NOT trusted markup. This module
 * is the single escaping boundary for the whole SEO path — `seo/resolvers.ts`
 * deliberately returns plain text and never HTML, so nothing can reach the
 * page having bypassed `escapeHtmlAttribute()` below.
 */
import type { PageMeta } from './types';

/** The existing `<title>…</title>`, if the shell has one. Non-global: there is exactly one. */
const TITLE_PATTERN = /<title>[\s\S]*?<\/title>/i;

/**
 * The existing description meta, if the shell has one. `[^>]*` spans the
 * newlines Prettier puts inside the tag in client/index.html — `.` would not.
 */
const DESCRIPTION_PATTERN = /<meta\s[^>]*name=["']description["'][^>]*>/i;

const HEAD_CLOSE_PATTERN = /<\/head\s*>/i;

/**
 * Escapes a string for use inside a double-quoted HTML attribute — and for
 * `<title>`'s text content, which has the same breakout risk through `<`.
 *
 * `&` goes first, or the ampersands introduced by the later replacements get
 * escaped a second time.
 */
export function escapeHtmlAttribute(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Serialises one JSON-LD node for embedding in a `<script>` element.
 *
 * `<`, `>` and `&` become `\uXXXX` escapes. The brief's requirement is that
 * `</` cannot appear (so a `</script>` inside admin content cannot close the
 * element early); escaping every `<` is strictly stronger — it also kills the
 * `<!--` sequence, which HTML's script-data parsing treats specially — and the
 * result is still valid JSON that `JSON.parse` returns the original string
 * from. Nothing is lost by being thorough here.
 */
function serialiseJsonLd(node: unknown): string {
  return JSON.stringify(node)
    .replace(/&/g, '\\u0026')
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e');
}

function buildHeadTags(meta: PageMeta): string[] {
  const title = escapeHtmlAttribute(meta.title);
  const description = escapeHtmlAttribute(meta.description);
  const canonical = escapeHtmlAttribute(meta.canonical);

  const tags: string[] = [];

  // FIRST, ahead of the canonical and JSON-LD tags: the preload scanner reads
  // the head in order, and this is the one tag whose whole purpose is to start
  // a download as early as possible.
  if (meta.preload) {
    const { type, srcset, sizes } = meta.preload;
    tags.push(
      `<link rel="preload" as="image" type="${escapeHtmlAttribute(type)}" imagesrcset="${escapeHtmlAttribute(srcset)}" imagesizes="${escapeHtmlAttribute(sizes)}" fetchpriority="high">`,
    );
  }

  tags.push(
    `<link rel="canonical" href="${canonical}">`,
    `<meta property="og:type" content="${meta.ogType}">`,
    `<meta property="og:title" content="${title}">`,
    `<meta property="og:description" content="${description}">`,
    `<meta property="og:url" content="${canonical}">`,
    `<meta name="twitter:card" content="${meta.ogImage ? 'summary_large_image' : 'summary'}">`,
    `<meta name="twitter:title" content="${title}">`,
    `<meta name="twitter:description" content="${description}">`,
  );

  if (meta.ogImage) {
    const image = escapeHtmlAttribute(meta.ogImage);
    tags.push(`<meta property="og:image" content="${image}">`);
    tags.push(`<meta name="twitter:image" content="${image}">`);
  }

  // Only the restrictive value is emitted: `index,follow` is already every
  // crawler's default, and a tag saying so is noise that can only go wrong.
  if (meta.robots === 'noindex,nofollow') {
    tags.push(`<meta name="robots" content="${meta.robots}">`);
  }

  // One script per node (Google reads several happily), so a single bad node
  // cannot invalidate the rest of the graph.
  for (const node of meta.jsonLd) {
    tags.push(`<script type="application/ld+json">${serialiseJsonLd(node)}</script>`);
  }

  return tags;
}

/** Puts markup just before `</head>`, or at the end of the document if there is no head to find. */
function insertIntoHead(html: string, markup: string): string {
  if (!markup) return html;

  const match = HEAD_CLOSE_PATTERN.exec(html);
  if (!match) return `${html}\n${markup}`;

  return `${html.slice(0, match.index)}${markup}\n  ${html.slice(match.index)}`;
}

/**
 * Returns `html` with `meta` applied: the existing title and description are
 * REPLACED (never duplicated — two titles is a real SEO defect), and the
 * canonical, Open Graph, Twitter, robots and JSON-LD tags are appended to the
 * head.
 *
 * The input shell is never mutated; a new string comes back, so one cached
 * template serves every request.
 */
export function injectMeta(html: string, meta: PageMeta): string {
  const titleTag = `<title>${escapeHtmlAttribute(meta.title)}</title>`;
  const descriptionTag = `<meta name="description" content="${escapeHtmlAttribute(meta.description)}">`;

  let out = TITLE_PATTERN.test(html)
    ? html.replace(TITLE_PATTERN, titleTag)
    : insertIntoHead(html, `${titleTag}\n    `);

  out = DESCRIPTION_PATTERN.test(out)
    ? out.replace(DESCRIPTION_PATTERN, descriptionTag)
    : insertIntoHead(out, `${descriptionTag}\n    `);

  return insertIntoHead(out, buildHeadTags(meta).join('\n    '));
}
