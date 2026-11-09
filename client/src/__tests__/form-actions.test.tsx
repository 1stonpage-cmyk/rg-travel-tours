/**
 * B1 (DEMO POLISH batch, 2026-11-09) — `FormActions`, the shared form
 * footer (owner decision 1: "actions in a footer at the bottom,
 * right-aligned (Cancel, then primary)"). Covers both wiring modes
 * (`submitType="submit"` for a form EntityForm already wraps, and
 * `submitType="button"` for content that sits outside that `<form>`, e.g.
 * the transfer-routes price table) and the sticky variant.
 */
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import FormActions from '@/components/admin/FormActions';

describe('FormActions', () => {
  it('renders Cancel before the primary Save button, in that reading order', () => {
    render(<FormActions onCancel={() => {}} saveLabel="Save changes" submitType="button" />);
    const buttons = screen.getAllByRole('button');
    expect(buttons).toHaveLength(2);
    expect(buttons[0]).toHaveTextContent('Cancel');
    expect(buttons[1]).toHaveTextContent('Save changes');
  });

  it('omits Cancel entirely when no onCancel is given', () => {
    render(<FormActions saveLabel="Add route" submitType="button" onSave={() => {}} />);
    expect(screen.queryByRole('button', { name: 'Cancel' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Add route' })).toBeInTheDocument();
  });

  it('submitType="button" calls onSave via onClick, not a form submit', async () => {
    const user = userEvent.setup();
    const onSave = vi.fn();
    render(<FormActions saveLabel="Save changes" submitType="button" onSave={onSave} />);
    const button = screen.getByRole('button', { name: 'Save changes' });
    expect(button).toHaveAttribute('type', 'button');
    await user.click(button);
    expect(onSave).toHaveBeenCalledTimes(1);
  });

  it('submitType="submit" (the default) renders a real submit button and never calls onSave directly', async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn((event: { preventDefault: () => void }) => event.preventDefault());
    const onSave = vi.fn();
    render(
      <form onSubmit={onSubmit}>
        <FormActions saveLabel="Save changes" onSave={onSave} />
      </form>,
    );
    const button = screen.getByRole('button', { name: 'Save changes' });
    expect(button).toHaveAttribute('type', 'submit');
    await user.click(button);
    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(onSave).not.toHaveBeenCalled();
  });

  it('shows "Saving…" and disables both buttons while pending', () => {
    render(
      <FormActions onCancel={() => {}} saveLabel="Save changes" pending submitType="button" />,
    );
    expect(screen.getByRole('button', { name: 'Saving…' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeDisabled();
  });

  it('uses a custom cancelLabel when given', () => {
    render(
      <FormActions
        onCancel={() => {}}
        cancelLabel="Discard"
        saveLabel="Save changes"
        submitType="button"
      />,
    );
    expect(screen.getByRole('button', { name: 'Discard' })).toBeInTheDocument();
  });

  it('sticky mode pins the footer to the bottom with a top border', () => {
    render(<FormActions saveLabel="Save changes" submitType="button" sticky />);
    const footer = screen.getByRole('button', { name: 'Save changes' }).closest('div')!;
    expect(footer.className).toMatch(/\bsticky\b/);
    expect(footer.className).toMatch(/\bbottom-0\b/);
  });
});
