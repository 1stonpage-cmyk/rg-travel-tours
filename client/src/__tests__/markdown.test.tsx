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

  it('renders a mailto link without target=_blank', () => {
    render(<Markdown source={'[email us](mailto:hello@example.com)'} />);
    const link = screen.getByRole('link', { name: 'email us' });
    expect(link).toHaveAttribute('href', 'mailto:hello@example.com');
    expect(link).not.toHaveAttribute('target');
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
