import type { SVGProps } from 'react';

/**
 * Official WhatsApp and Viber brand glyphs, inline (spec task 2.9I) — no
 * icon-library dependency, and kept unmodified (no recolouring, stretching
 * or outlines) per each brand's guidelines. `fill="currentColor"` so the
 * glyph stays white via the pill's own text colour.
 *
 * The path data is intentionally identical to the one already shipped in
 * `coming-soon/index.html`, so the two surfaces render the same official
 * mark rather than two independently-drawn approximations of it.
 */

export function WhatsAppGlyph(props: SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" focusable="false" {...props}>
      <path d="M12.04 2C6.58 2 2.13 6.45 2.13 11.91c0 1.75.46 3.45 1.32 4.95L2 22l5.25-1.38a9.9 9.9 0 0 0 4.79 1.22h.01c5.46 0 9.91-4.45 9.91-9.91C21.96 6.45 17.5 2 12.04 2Zm0 18.15h-.01a8.2 8.2 0 0 1-4.19-1.15l-.3-.18-3.12.82.83-3.04-.2-.31a8.22 8.22 0 0 1-1.26-4.38c0-4.54 3.7-8.23 8.25-8.23 2.2 0 4.27.86 5.83 2.41a8.18 8.18 0 0 1 2.41 5.83c0 4.54-3.7 8.23-8.24 8.23Zm4.52-6.16c-.25-.12-1.47-.72-1.69-.81-.23-.08-.39-.12-.56.13-.16.24-.64.8-.78.97-.15.16-.29.18-.54.06-.25-.13-1.05-.39-1.99-1.23-.74-.66-1.23-1.47-1.38-1.72-.14-.25-.01-.38.11-.5.11-.11.25-.29.37-.43.13-.15.17-.25.25-.41.08-.17.04-.31-.02-.43-.06-.12-.56-1.34-.76-1.84-.2-.48-.41-.42-.56-.43h-.48c-.17 0-.43.06-.66.31-.22.25-.87.85-.87 2.07s.9 2.4 1.02 2.56c.12.17 1.76 2.68 4.26 3.76.6.26 1.06.41 1.42.52.6.19 1.14.16 1.57.1.48-.07 1.47-.6 1.68-1.18.21-.58.21-1.08.14-1.18-.06-.11-.22-.17-.47-.29Z" />
    </svg>
  );
}

export function ViberGlyph(props: SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" focusable="false" {...props}>
      <path d="M12 2C7.86 2 4.5 4.9 4.5 8.48c0 2.03 1.08 3.84 2.78 5.03v3.07l2.6-1.43c.68.17 1.4.27 2.12.27 4.14 0 7.5-2.9 7.5-6.94C19.5 4.9 16.14 2 12 2Zm-3.7 7.73a.95.95 0 1 1 0-1.9.95.95 0 0 1 0 1.9Zm3.7 0a.95.95 0 1 1 0-1.9.95.95 0 0 1 0 1.9Zm3.7 0a.95.95 0 1 1 0-1.9.95.95 0 0 1 0 1.9ZM6.9 18.3c.5 1.3 1.9 2.2 3.5 2.2h.3l1.5 1.5v-1.7c1.4-.3 2.5-1.1 3-2.2a9.9 9.9 0 0 1-8.3.2Z" />
    </svg>
  );
}
