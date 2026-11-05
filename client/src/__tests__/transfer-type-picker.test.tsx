/**
 * `TransferTypePicker` (Task T13) — presentational, no tRPC. Covers: renders
 * both bookable types with no crash, the callback fires the right value, the
 * selected state is reflected, and a resolved field error renders where
 * `aria-describedby` points.
 */
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import TransferTypePicker from '@/components/transfer/TransferTypePicker';

describe('TransferTypePicker', () => {
  it('renders both bookable transfer types with no crash', () => {
    render(<TransferTypePicker value={null} onChange={() => {}} />);
    expect(screen.getByLabelText(/airport transfer/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/day use/i)).toBeInTheDocument();
    // Not the plan's third "Custom trip request" product — out of scope here.
    expect(screen.queryByText(/custom trip/i)).not.toBeInTheDocument();
  });

  it('fires onChange with the clicked type', async () => {
    const onChange = vi.fn();
    const user = userEvent.setup();
    render(<TransferTypePicker value={null} onChange={onChange} />);

    await user.click(screen.getByLabelText(/day use/i));
    expect(onChange).toHaveBeenCalledWith('transfer_day_use');

    await user.click(screen.getByLabelText(/airport transfer/i));
    expect(onChange).toHaveBeenCalledWith('transfer_one_way');
  });

  it('marks the radio matching `value` as checked, and only that one', () => {
    render(<TransferTypePicker value="transfer_day_use" onChange={() => {}} />);
    expect(screen.getByLabelText(/day use/i)).toBeChecked();
    expect(screen.getByLabelText(/airport transfer/i)).not.toBeChecked();
  });

  it('renders a resolved error message wired to the fieldset via aria-describedby', () => {
    render(<TransferTypePicker value={null} onChange={() => {}} error="Choose a transfer type." />);
    const message = screen.getByText('Choose a transfer type.');
    expect(message).toHaveAttribute('role', 'alert');
    const fieldset = message.closest('fieldset');
    expect(fieldset).toHaveAttribute('aria-describedby', message.id);
  });

  it('renders nothing for the error paragraph when no error is given', () => {
    render(<TransferTypePicker value={null} onChange={() => {}} />);
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });
});
