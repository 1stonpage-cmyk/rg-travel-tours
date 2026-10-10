import { HERO_IMAGE_PRELOAD } from '@rg/shared';
import { describe, expect, it } from 'vitest';
import { escapeHtmlAttribute, injectMeta } from '../seo/render';
import type { PageMeta } from '../seo/types';

/** A shell shaped like the real client/index.html, description meta included. */
const HTML = `<!doctype html><html lang="en"><head>
<meta charset="UTF-8" />
<title>TravelSugbo — Cebu Day Tours &amp; Packages</title>
<meta name="description" content="old description" />
</head><body><div id="root"></div></body></html>`;

/** The content of the first JSON-LD script in `html`, or '' when there is none. */
function firstJsonLd(html: string): string {
  return /<script type="application\/ld\+json">([\s\S]*?)<\/script>/.exec(html)?.[1] ?? '';
}

const META: PageMeta = {
  title: 'Oslob Whale Sharks | TravelSugbo',
  description: 'Swim with whale sharks.',
  canonical: 'https://travelsugbo.com/tours/oslob',
  ogImage: 'https://travelsugbo.com/hero/hero-cebu-1920.jpg',
  ogType: 'website',
  jsonLd: [{ '@context': 'https://schema.org', '@type': 'TravelAgency', name: 'TravelSugbo' }],
  preload: null,
  status: 200,
  robots: 'index,follow',
};

describe('injectMeta', () => {
  const out = injectMeta(HTML, META);

  it('replaces the existing title rather than adding a second one', () => {
    expect(out.match(/<title>/g)).toHaveLength(1);
    expect(out).toContain('<title>Oslob Whale Sharks | TravelSugbo</title>');
  });

  it('replaces the existing description rather than adding a second one', () => {
    expect(out.match(/name="description"/g)).toHaveLength(1);
    expect(out).toContain('content="Swim with whale sharks."');
  });

  it('adds canonical, Open Graph and Twitter tags', () => {
    expect(out).toContain('<link rel="canonical" href="https://travelsugbo.com/tours/oslob">');
    expect(out).toContain('property="og:title"');
    expect(out).toContain('property="og:image"');
    expect(out).toContain('name="twitter:card"');
  });

  it('puts everything it adds inside the head', () => {
    const head = out.slice(0, out.indexOf('</head>'));
    expect(head).toContain('rel="canonical"');
    expect(head).toContain('property="og:url"');
    expect(head).toContain('application/ld+json');
  });

  it('embeds JSON-LD as valid, parseable JSON', () => {
    const script = firstJsonLd(out);
    expect(script).not.toBe('');
    expect(() => JSON.parse(script)).not.toThrow();
    expect(JSON.parse(script)).toMatchObject({ '@type': 'TravelAgency' });
  });

  it('emits no JSON-LD script at all when there are no nodes (task 4.1 state)', () => {
    expect(injectMeta(HTML, { ...META, jsonLd: [] })).not.toContain('application/ld+json');
  });

  it('escapes a quote or angle bracket in the title so markup cannot break out', () => {
    const evil = injectMeta(HTML, { ...META, title: 'He said "hi" <script>' });
    expect(evil).not.toContain('<script>He');
    expect(evil).toContain('&quot;hi&quot;');
    expect(evil).toContain('&lt;script&gt;');
  });

  it('escapes a quote in the description so it cannot end the content attribute', () => {
    const evil = injectMeta(HTML, {
      ...META,
      description: '" onload="alert(1)',
    });
    expect(evil).not.toContain('onload="alert(1)"');
    expect(evil).toContain('&quot; onload=&quot;alert(1)');
  });

  it('escapes </script> inside JSON-LD', () => {
    const evil = injectMeta(HTML, {
      ...META,
      jsonLd: [{ name: '</script><script>alert(1)</script>' }],
    });
    expect(evil).not.toMatch(/<\/script><script>alert/);
    // Still round-trips: escaping must not corrupt the data it protects.
    expect(JSON.parse(firstJsonLd(evil)).name).toBe('</script><script>alert(1)</script>');
  });

  it('emits no preload link for a route that asks for none (4.4b)', () => {
    expect(out).not.toContain('rel="preload"');
  });

  it('emits the image preload a route does ask for, inside the head and before the JSON-LD', () => {
    const withHero = injectMeta(HTML, { ...META, preload: HERO_IMAGE_PRELOAD });

    const link = /<link [^>]*rel="preload"[^>]*>/.exec(withHero)?.[0];
    expect(link, 'no rel="preload" link emitted').toBeTruthy();
    expect(link).toContain('as="image"');
    expect(link).toContain('type="image/webp"');
    expect(link).toContain(`imagesrcset="${HERO_IMAGE_PRELOAD.srcset}"`);
    expect(link).toContain(`imagesizes="${HERO_IMAGE_PRELOAD.sizes}"`);
    expect(link).toContain('fetchpriority="high"');

    // In the head, and ahead of the inline JSON-LD — the preload scanner reads
    // the head top-down and this tag exists to start a download early.
    const headEnd = withHero.indexOf('</head>');
    expect(withHero.indexOf('rel="preload"')).toBeLessThan(headEnd);
    expect(withHero.indexOf('rel="preload"')).toBeLessThan(withHero.indexOf('application/ld+json'));
  });

  it('escapes a quote in a preload candidate list so it cannot end the attribute', () => {
    const evil = injectMeta(HTML, {
      ...META,
      preload: { type: 'image/webp', srcset: '" onload="alert(1)', sizes: '100vw' },
    });
    expect(evil).not.toContain('onload="alert(1)"');
    expect(evil).toContain('&quot; onload=&quot;alert(1)');
  });

  it('emits a robots meta only when noindex', () => {
    expect(out).not.toContain('name="robots"');
    expect(injectMeta(HTML, { ...META, robots: 'noindex,nofollow' })).toContain(
      'content="noindex,nofollow"',
    );
  });

  it('omits the image tags, and downgrades the Twitter card, when there is no OG image', () => {
    const noImage = injectMeta(HTML, { ...META, ogImage: null });
    expect(noImage).not.toContain('og:image');
    expect(noImage).not.toContain('twitter:image');
    expect(noImage).toContain('name="twitter:card" content="summary"');
  });

  it('adds a title and description to a shell that has neither', () => {
    const bare = '<!doctype html><html><head><meta charset="UTF-8" /></head><body></body></html>';
    const outBare = injectMeta(bare, META);
    expect(outBare.match(/<title>/g)).toHaveLength(1);
    expect(outBare.match(/name="description"/g)).toHaveLength(1);
    expect(outBare.indexOf('<title>')).toBeLessThan(outBare.indexOf('</head>'));
  });
});

describe('escapeHtmlAttribute', () => {
  it('escapes the five markup-significant characters', () => {
    expect(escapeHtmlAttribute(`&<>"'`)).toBe('&amp;&lt;&gt;&quot;&#39;');
  });

  it('escapes the ampersand first, so nothing is double-escaped', () => {
    expect(escapeHtmlAttribute('Tours & Packages')).toBe('Tours &amp; Packages');
    expect(escapeHtmlAttribute('&lt;')).toBe('&amp;lt;');
  });
});
