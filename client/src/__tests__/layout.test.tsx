import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import PublicLayout from '@/components/layout/PublicLayout';

function renderLayout() {
  return render(
    <MemoryRouter>
      <PublicLayout />
    </MemoryRouter>,
  );
}

describe('PublicLayout', () => {
  it('renders a banner, a contentinfo footer, and a main region', () => {
    renderLayout();
    expect(screen.getByRole('banner')).toBeInTheDocument();
    expect(screen.getByRole('contentinfo')).toBeInTheDocument();
    expect(screen.getByRole('main')).toBeInTheDocument();
  });

  it('shows DOT, DTI, and BIR permit lines in the footer', () => {
    renderLayout();
    const footer = screen.getByRole('contentinfo');
    expect(footer).toHaveTextContent(/DOT/);
    expect(footer).toHaveTextContent(/DTI/);
    expect(footer).toHaveTextContent(/BIR/);
  });

  it('lists accepted payment methods in the footer', () => {
    renderLayout();
    const footer = screen.getByRole('contentinfo');
    for (const method of ['GCash', 'Maya', 'GrabPay', 'QR Ph']) {
      expect(footer).toHaveTextContent(method);
    }
  });

  it('renders a floating WhatsApp link with an accessible name', () => {
    renderLayout();
    const link = screen.getByRole('link', { name: /whatsapp/i });
    expect(link).toHaveAttribute('href', expect.stringContaining('wa.me'));
  });

  it('exposes a skip link to the main content', () => {
    renderLayout();
    expect(screen.getByRole('link', { name: /skip to (main )?content/i })).toBeInTheDocument();
  });
});
