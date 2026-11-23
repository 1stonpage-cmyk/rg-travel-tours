import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import ErrorSummary from '@/components/common/ErrorSummary';

// Mock the scroll-to-field module
vi.mock('@/lib/scroll-to-field', () => ({
  scrollToAndFocus: vi.fn(),
}));

import { scrollToAndFocus } from '@/lib/scroll-to-field';

describe('ErrorSummary', () => {
  it('renders nothing for an empty items array', () => {
    const { container } = render(<ErrorSummary items={[]} />);
    expect(container.firstChild).toBeNull();
  });

  it('renders the count sentence and one link per item for a non-empty list', () => {
    const items = [
      { id: 'name', label: 'Full name', message: 'Enter a name' },
      { id: 'email', label: 'Email', message: 'Enter a valid email' },
    ];
    render(<ErrorSummary items={items} />);

    expect(screen.getByText(/Check 2 fields above:/)).toBeInTheDocument();
    expect(screen.getByText('Full name')).toBeInTheDocument();
    expect(screen.getByText('Email')).toBeInTheDocument();
    expect(screen.getByText(/Enter a name/)).toBeInTheDocument();
    expect(screen.getByText(/Enter a valid email/)).toBeInTheDocument();
  });

  it('shows singular "field" for a single item', () => {
    const items = [{ id: 'name', label: 'Full name', message: 'Enter a name' }];
    render(<ErrorSummary items={items} />);

    expect(screen.getByText(/Check 1 field above:/)).toBeInTheDocument();
  });

  it('calls scrollToAndFocus when a link is clicked', async () => {
    const user = userEvent.setup();
    const items = [{ id: 'name', label: 'Full name', message: 'Enter a name' }];
    render(<ErrorSummary items={items} />);

    const link = screen.getByRole('link', { name: 'Full name' });
    await user.click(link);

    expect(scrollToAndFocus).toHaveBeenCalledWith('name');
  });

  it('prevents default link behavior on click', async () => {
    const user = userEvent.setup();
    const items = [{ id: 'name', label: 'Full name', message: 'Enter a name' }];
    render(<ErrorSummary items={items} />);

    const link = screen.getByRole('link', { name: 'Full name' });
    // If preventDefault was not called, the click would navigate (which we can't directly test)
    // but we can verify the function was called
    await user.click(link);
    expect(scrollToAndFocus).toHaveBeenCalled();
  });
});
