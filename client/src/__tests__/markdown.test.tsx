import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import Markdown from '@/components/common/Markdown';

describe('Markdown', () => {
  it('renders headings at the right level', () => {
    render(<Markdown source={'## Data we collect'} />);
    expect(screen.getByRole('heading', { level: 2, name: 'Data we collect' })).toBeInTheDocument();
  });

  it('renders a level-3 heading', () => {
    render(<Markdown source={'### Sub-point'} />);
    expect(screen.getByRole('heading', { level: 3, name: 'Sub-point' })).toBeInTheDocument();
  });

  /**
   * Ruling (coordinator): a single `#` is supported, but demoted to the
   * same `<h2>` as `##` — never `<h1>`. The page component keeps sole
   * ownership of the document's one real `<h1>`; the renderer must never be
   * able to mint a second one, however an admin writes their markdown.
   */
  it('demotes a single "#" heading to h2, never h1', () => {
    render(<Markdown source={'# Title'} />);
    expect(screen.getByRole('heading', { level: 2, name: 'Title' })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { level: 1 })).not.toBeInTheDocument();
  });

  it('renders paragraphs, bold text and bullet lists', () => {
    render(<Markdown source={'Hello **world**\n\n- one\n- two'} />);
    expect(screen.getByText('world').tagName).toBe('STRONG');
    expect(screen.getAllByRole('listitem')).toHaveLength(2);
  });

  it('renders links and marks external ones safely', () => {
    render(<Markdown source={'[site](https://example.com)'} />);
    const link = screen.getByRole('link', { name: 'site' });
    expect(link).toHaveAttribute('href', 'https://example.com');
    expect(link).toHaveAttribute('rel', expect.stringContaining('noopener'));
  });

  it('renders a relative link without target=_blank', () => {
    render(<Markdown source={'[home](/)'} />);
    const link = screen.getByRole('link', { name: 'home' });
    expect(link).toHaveAttribute('href', '/');
    expect(link).not.toHaveAttribute('target');
  });

  it('renders a mailto link without target=_blank, but still with rel=noopener noreferrer', () => {
    render(<Markdown source={'[email us](mailto:hello@example.com)'} />);
    const link = screen.getByRole('link', { name: 'email us' });
    expect(link).toHaveAttribute('href', 'mailto:hello@example.com');
    expect(link).not.toHaveAttribute('target');
    // Anything that is not a same-site path carries rel, not just http(s).
    expect(link).toHaveAttribute('rel', 'noopener noreferrer');
  });

  /**
   * The seeded legal documents are hard-wrapped at ~75 columns, so almost
   * every real paragraph arrives as several short lines. They must join
   * into ONE `<p>` with single spaces — not one paragraph per line, and not
   * with the newlines preserved. This path was untested anywhere despite
   * being the shape of all the actual content.
   */
  it('joins a hard-wrapped paragraph into a single <p>', () => {
    const { container } = render(
      <Markdown
        source={
          'TravelSugbo (operated by R&G Travel & Tours) collects the contact and booking\ndetails you provide when you reserve a tour, so we can confirm your trip and\nassign a driver.\n\nA second paragraph.'
        }
      />,
    );

    const paragraphs = Array.from(container.querySelectorAll('p'));
    expect(paragraphs).toHaveLength(2);
    expect(paragraphs[0]!.textContent).toBe(
      'TravelSugbo (operated by R&G Travel & Tours) collects the contact and booking details you provide when you reserve a tour, so we can confirm your trip and assign a driver.',
    );
    expect(paragraphs[1]!.textContent).toBe('A second paragraph.');
  });

  it('renders a blockquote', () => {
    render(<Markdown source={'> **TODO: client legal review.** Placeholder text.'} />);
    expect(screen.getByText(/Placeholder text\./).closest('blockquote')).toBeInTheDocument();
  });

  it('never executes or injects raw HTML', () => {
    render(<Markdown source={'<img src=x onerror="alert(1)"> and <script>bad()</script>'} />);
    expect(document.querySelector('img')).toBeNull();
    expect(document.querySelector('script')).toBeNull();
    expect(screen.getByText(/onerror/)).toBeInTheDocument(); // shown as literal text
  });

  it('refuses a javascript: link', () => {
    render(<Markdown source={'[bad](javascript:alert(1))'} />);
    expect(screen.queryByRole('link')).toBeNull();
  });

  it('refuses a data: link', () => {
    render(<Markdown source={'[bad](data:text/html,<script>bad()</script>)'} />);
    expect(screen.queryByRole('link')).toBeNull();
  });
});

/**
 * The href allowlist, case by case. Legal copy becomes admin-*editable* in
 * Weeks 5–7, so every one of these is a stored-link vector behind a login,
 * not a theoretical exercise.
 *
 * The scheme-relative family is the one that was actually broken: the
 * predicate used to return `true` for anything starting with "/", and a
 * browser resolves `//evil.com`, `///evil.com` and `/\evil.com` as
 * protocol-relative URLs to `https://evil.com/`. The uppercase,
 * tab-obfuscated, URL-encoded, `vbscript:` and `data:` cases already passed
 * but had no test naming them, so a future "simplification" of the scheme
 * check could have reopened any of them silently.
 *
 * A rejected href must leave the whole `[text](url)` span as literal text —
 * never a link with the href stripped, and never silently dropped (dropping
 * admin-authored text is its own bug).
 */
describe('Markdown href allowlist', () => {
  const REJECTED: [label: string, href: string][] = [
    ['a scheme-relative URL', '//evil.com'],
    ['a triple-slash URL', '///evil.com'],
    ['a backslash scheme-relative URL', '/\\evil.com'],
    ['an uppercase JAVASCRIPT: scheme', 'JAVASCRIPT:alert(1)'],
    ['a tab-obfuscated javascript: scheme', 'java\tscript:alert(1)'],
    ['a URL-encoded javascript: scheme', '%6Aavascript:alert(1)'],
    ['a vbscript: scheme', 'vbscript:msgbox(1)'],
    ['a data: URL', 'data:text/html,<b>x</b>'],
  ];

  it.each(REJECTED)('refuses %s, rendering it as literal text', (_label, href) => {
    const source = `[click](${href})`;
    const { container } = render(<Markdown source={source} />);

    expect(screen.queryByRole('link')).toBeNull();
    expect(container.querySelector('a')).toBeNull();
    // Shown, not swallowed — the exact source text survives.
    expect(container.textContent).toContain(source);
  });

  it('still accepts a genuine same-site path, with no rel and no target', () => {
    render(<Markdown source={'[privacy](/privacy)'} />);
    const link = screen.getByRole('link', { name: 'privacy' });
    expect(link).toHaveAttribute('href', '/privacy');
    expect(link).not.toHaveAttribute('target');
    expect(link).not.toHaveAttribute('rel');
  });
});
