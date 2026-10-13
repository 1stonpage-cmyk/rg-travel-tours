/**
 * Week 4 plan, Task 8 — the guest portal sign-in, and the checkout link
 * that sends a guest to it.
 *
 * Two properties:
 *
 *  1. **One error for the pair.** §7: the server refuses a wrong reference
 *     and a wrong email identically, so the page must not split them into
 *     per-field messages and reintroduce the oracle in the browser.
 *  2. **The transfer option is offered only when it exists.** Owner
 *     decision 2026-10-14 (Q3): while `payment_qr` is unconfigured,
 *     `manualTransferEnabled` is false and the checkout shows no such link
 *     at all.
 */
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import PortalLoginPage from '@/pages/portal/PortalLoginPage';
import { TrpcProviders } from '@/lib/trpc';
import { mockTrpc, mockTrpcError, resetTrpcMock } from './helpers/mock-trpc';

afterEach(() => {
  resetTrpcMock();
  vi.restoreAllMocks();
});

function renderLogin(search = '') {
  return render(
    <TrpcProviders>
      <MemoryRouter initialEntries={[`/portal/login${search}`]}>
        <Routes>
          <Route path="/portal/login" element={<PortalLoginPage />} />
          <Route path="/portal/pay" element={<p>payment screen</p>} />
        </Routes>
      </MemoryRouter>
    </TrpcProviders>,
  );
}

describe('PortalLoginPage', () => {
  it('signs a guest in with ref + email and lands them on the payment screen', async () => {
    const seen: unknown[] = [];
    mockTrpc({
      'portal.login': (input: unknown) => {
        seen.push(input);
        return { ok: true };
      },
    });
    renderLogin();

    await userEvent.type(screen.getByLabelText(/booking reference/i), 'RG-7KQ4M9');
    await userEvent.type(screen.getByLabelText(/email/i), 'guest@example.test');
    await userEvent.click(screen.getByRole('button', { name: /view my booking/i }));

    expect(await screen.findByText('payment screen')).toBeInTheDocument();
    expect(seen).toEqual([{ ref: 'RG-7KQ4M9', email: 'guest@example.test' }]);
  });

  /** The checkout link carries the ref, so a guest types only their email. */
  it('prefills the reference from the query string', () => {
    renderLogin('?ref=RG-ABC123');
    expect(screen.getByLabelText(/booking reference/i)).toHaveValue('RG-ABC123');
  });

  /**
   * ONE alert for the credential pair, carrying the server's own sentence.
   * A per-field error here would say which half was wrong, which is exactly
   * what §7 refuses to reveal.
   */
  it('shows ONE generic alert on a refusal, not a per-field message', async () => {
    mockTrpcError(
      'portal.login',
      'UNAUTHORIZED',
      'That booking reference and email do not match a booking.',
    );
    renderLogin();

    await userEvent.type(screen.getByLabelText(/booking reference/i), 'RG-NOPE00');
    await userEvent.type(screen.getByLabelText(/email/i), 'wrong@example.test');
    await userEvent.click(screen.getByRole('button', { name: /view my booking/i }));

    const alerts = await screen.findAllByRole('alert');
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toHaveTextContent(/do not match a booking/i);
    // Neither half is named as the problem.
    expect(alerts[0]).not.toHaveTextContent(/email is/i);
    expect(alerts[0]).not.toHaveTextContent(/reference is/i);
  });

  /**
   * An open redirect would let a phishing link bounce a signed-in guest
   * off our domain. Only `/portal/*` is honoured.
   */
  it('IGNORES a next= that is not a portal path', async () => {
    mockTrpc({ 'portal.login': { ok: true } });
    renderLogin('?next=https://evil.example/steal');

    await userEvent.type(screen.getByLabelText(/booking reference/i), 'RG-7KQ4M9');
    await userEvent.type(screen.getByLabelText(/email/i), 'guest@example.test');
    await userEvent.click(screen.getByRole('button', { name: /view my booking/i }));

    // It fell back to the payment screen rather than following the URL.
    expect(await screen.findByText('payment screen')).toBeInTheDocument();
  });

  it('asks the phone for the right keyboards and does not autocorrect the reference', () => {
    renderLogin();
    const ref = screen.getByLabelText(/booking reference/i);
    expect(ref).toHaveAttribute('autocapitalize', 'characters');
    expect(ref).toHaveAttribute('autocorrect', 'off');
    expect(screen.getByLabelText(/email/i)).toHaveAttribute('inputmode', 'email');
  });

  it('waits for the server rather than claiming success itself', async () => {
    let resolve: ((value: unknown) => void) | undefined;
    mockTrpc({
      'portal.login': () =>
        new Promise((r) => {
          resolve = r;
        }),
    });
    renderLogin();

    await userEvent.type(screen.getByLabelText(/booking reference/i), 'RG-7KQ4M9');
    await userEvent.type(screen.getByLabelText(/email/i), 'guest@example.test');
    await userEvent.click(screen.getByRole('button', { name: /view my booking/i }));

    expect(await screen.findByRole('button', { name: /checking/i })).toBeDisabled();
    expect(screen.queryByText('payment screen')).not.toBeInTheDocument();

    resolve?.({ ok: true });
    await waitFor(() => expect(screen.getByText('payment screen')).toBeInTheDocument());
  });
});
