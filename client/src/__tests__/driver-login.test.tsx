/**
 * Week 6, Task 9 — the driver portal shell and its sign-in screen.
 *
 * `server/src/__tests__/driver-auth.test.ts` and `driver-lockout.test.ts`
 * prove the policy: five failures lock a driver out for fifteen minutes,
 * three lockouts in a day need a dispatcher, and a wrong code and a wrong
 * PIN are refused byte-identically. This file proves the SCREEN — and
 * almost all of what it proves is words, because on this screen the words
 * are the feature:
 *
 *  - one generic sentence for a refused pair, naming neither half;
 *  - "Locked for 15 minutes" and "Ask the office" as two DIFFERENT
 *    sentences, because the driver's next action differs and the second is
 *    the only useful thing to say at 5am when the van is leaving;
 *  - no attempt count, ever.
 *
 * ## What jsdom cannot see, and this file therefore does not claim
 *
 * jsdom performs no layout and loads no stylesheet. It can read a class
 * attribute; it cannot measure a box. So the assertions below check that
 * `tap-target` (the 44px utility) and the taller `h-14` / `h-16` classes
 * are PRESENT (and, for the one control whose height comes from
 * `inset-y-0` inside a 56px field rather than from a class, that it
 * stretches to that field) — not that anything is 44px or 56px on a
 * screen, not that
 * the pad falls in the thumb-reachable lower two-thirds of a 360px
 * viewport, and not where a fixed bar actually lands. Those are Task 14's
 * walkthrough in a real browser. DOM ORDER, on the other hand, jsdom does
 * see, so the pad's position relative to the identity field is asserted
 * rather than described.
 */
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, describe, expect, it } from 'vitest';
import DriverLayout from '@/components/layout/DriverLayout';
import DriverLoginPage from '@/pages/driver/DriverLoginPage';
import { SITE } from '@/lib/site';
import { TrpcProviders } from '@/lib/trpc';
import { mockTrpc, mockTrpcError, resetTrpcMock } from './helpers/mock-trpc';

afterEach(() => {
  resetTrpcMock();
});

const DRIVER = { driver: { id: 4, name: 'Rolando Bacus', code: 'D07' } };

function renderLogin() {
  return render(
    <TrpcProviders>
      <MemoryRouter initialEntries={['/driver/login']}>
        <Routes>
          <Route path="/driver/login" element={<DriverLoginPage />} />
          <Route path="/driver" element={<p>your trips</p>} />
        </Routes>
      </MemoryRouter>
    </TrpcProviders>,
  );
}

/** Taps `digits` on the on-screen pad, one button per character. */
async function tapPad(user: ReturnType<typeof userEvent.setup>, digits: string) {
  for (const digit of digits) {
    await user.click(screen.getByRole('button', { name: digit }));
  }
}

/** Signs in with a code and a six-digit PIN, then submits. */
async function signIn(user: ReturnType<typeof userEvent.setup>) {
  await user.type(screen.getByLabelText(/driver code/i), 'd07');
  await tapPad(user, '246810');
  await user.click(screen.getByRole('button', { name: /^sign in$/i }));
}

describe('DriverLoginPage — the pad', () => {
  it('builds a six-digit PIN from pad taps and sends it with the code', async () => {
    const sent: unknown[] = [];
    mockTrpc({
      'driver.login': (input: unknown) => {
        sent.push(input);
        return DRIVER;
      },
    });
    const user = userEvent.setup();
    renderLogin();

    await user.type(screen.getByLabelText(/driver code/i), 'd07');
    await tapPad(user, '135791');

    // Read back through the control itself, never a snapshot of the DOM.
    expect(screen.getByLabelText(/^pin$/i)).toHaveValue('135791');

    await user.click(screen.getByRole('button', { name: /^sign in$/i }));

    await screen.findByText('your trips');
    expect(sent).toEqual([{ code: 'd07', pin: '135791' }]);
  });

  it('stops at six digits and lets Delete and Clear take them back', async () => {
    mockTrpc({ 'driver.login': DRIVER });
    const user = userEvent.setup();
    renderLogin();

    await tapPad(user, '12345678');
    const pin = screen.getByLabelText(/^pin$/i);
    expect(pin).toHaveValue('123456');

    await user.click(screen.getByRole('button', { name: /delete/i }));
    expect(pin).toHaveValue('12345');

    await user.click(screen.getByRole('button', { name: /clear/i }));
    expect(pin).toHaveValue('');
  });

  it('shows the PIN by default and hides it only when asked', async () => {
    mockTrpc({ 'driver.login': DRIVER });
    const user = userEvent.setup();
    renderLogin();

    const pin = screen.getByLabelText(/^pin$/i);
    // Owner decision 2026-10-15 (Q6): the threat beside a van is a mistype.
    expect(pin).toHaveAttribute('type', 'text');
    expect(pin).toHaveAttribute('inputmode', 'numeric');
    expect(pin).toHaveAttribute('autocomplete', 'one-time-code');

    await user.click(screen.getByRole('button', { name: /hide pin/i }));
    expect(pin).toHaveAttribute('type', 'password');

    await user.click(screen.getByRole('button', { name: /show pin/i }));
    expect(pin).toHaveAttribute('type', 'text');
  });

  it('will not submit until there is a code and six digits', async () => {
    mockTrpc({ 'driver.login': DRIVER });
    const user = userEvent.setup();
    renderLogin();

    const submit = screen.getByRole('button', { name: /^sign in$/i });
    expect(submit).toBeDisabled();

    await user.type(screen.getByLabelText(/driver code/i), 'd07');
    await tapPad(user, '12345');
    expect(submit).toBeDisabled();

    await tapPad(user, '6');
    expect(submit).toBeEnabled();
  });

  it('shows a working state while the sign-in is in flight', async () => {
    let release: (() => void) | undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    mockTrpc({
      'driver.login': async () => {
        await held;
        return DRIVER;
      },
    });
    const user = userEvent.setup();
    renderLogin();

    await signIn(user);

    // A silent submit on a sign-in screen reads as a dead button and earns a
    // second tap, so the outcome is never the first thing the driver sees.
    expect(await screen.findByText(/signing in/i)).toBeInTheDocument();
    release?.();
    await screen.findByText('your trips');
  });
});

describe('DriverLoginPage — what a refusal is allowed to say', () => {
  it('names neither the code nor the PIN when the pair does not match', async () => {
    mockTrpcError('driver.login', 'UNAUTHORIZED', 'wrong_credentials');
    const user = userEvent.setup();
    renderLogin();
    await signIn(user);

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(/could not sign you in/i);
    // The server refuses an unknown code and a wrong PIN identically on
    // purpose. A sentence that named either half would hand back the oracle
    // the server withholds.
    expect(alert.textContent ?? '').not.toMatch(/\bcode\b/i);
    expect(alert.textContent ?? '').not.toMatch(/\bpin\b/i);
  });

  it('tells a locked-out driver to wait fifteen minutes, in amber', async () => {
    mockTrpcError('driver.login', 'FORBIDDEN', 'locked');
    const user = userEvent.setup();
    renderLogin();
    await signIn(user);

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(/locked for 15 minutes/i);
    // Amber, because it clears by itself (CLAUDE.md: warnings are amber).
    expect(alert.className).toMatch(/\bbg-amber-50\b/);
    expect(alert.className).toMatch(/\btext-amber-900\b/);
  });

  it('tells a driver who needs a dispatcher to ring the office, and never to wait', async () => {
    mockTrpcError('driver.login', 'FORBIDDEN', 'needs_admin_unlock');
    const user = userEvent.setup();
    renderLogin();
    await signIn(user);

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(/ask the office to reset your PIN/i);
    /*
     * THE POINT OF THIS FILE. `locked` clears by itself and
     * `needs_admin_unlock` does not, so a driver shown the fifteen-minute
     * sentence here waits a quarter of an hour, tries again, and is refused
     * again — while the van leaves. Collapsing the two into one sentence is
     * the failure this assertion exists to catch.
     */
    expect(alert.textContent ?? '').not.toMatch(/15 minutes/i);
    expect(alert.textContent ?? '').not.toMatch(/\bwait\b/i);
    // Dark blue/grey, because waiting will not fix it.
    expect(alert.className).toMatch(/\btext-brand-error\b/);
  });

  it('gives a deactivated code its own sentence without explaining itself', async () => {
    mockTrpcError('driver.login', 'FORBIDDEN', 'driver_inactive');
    const user = userEvent.setup();
    renderLogin();
    await signIn(user);

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(/cannot sign in/i);
    expect(alert).toHaveTextContent(/office/i);
  });

  it('says something human when the refusal carries no reason it knows', async () => {
    mockTrpcError('driver.login', 'INTERNAL_SERVER_ERROR', 'ECONNREFUSED at 10.0.0.4:3306');
    const user = userEvent.setup();
    renderLogin();
    await signIn(user);

    const alert = await screen.findByRole('alert');
    // Never the raw error (CLAUDE.md, BUG-021).
    expect(alert.textContent ?? '').not.toMatch(/ECONNREFUSED/);
    expect(alert).toHaveTextContent(/try again/i);
  });

  it('never shows how many attempts are left', async () => {
    mockTrpcError('driver.login', 'UNAUTHORIZED', 'wrong_credentials');
    const user = userEvent.setup();
    const { container } = renderLogin();
    await signIn(user);
    await screen.findByRole('alert');

    /*
     * "2 tries left" tells a shoulder-surfer how much room they have and
     * tells the driver nothing they can act on. The whole document is
     * checked, not just the alert — a counter tucked under the button would
     * be exactly as leaky.
     */
    const text = container.textContent ?? '';
    expect(text).not.toMatch(/\d+\s*(?:more\s+)?(?:tr(?:y|ies)|attempts?|goes?)\b/i);
    expect(text).not.toMatch(/\b(?:tries|attempts|goes)\s+(?:left|remaining)\b/i);
    expect(text).not.toMatch(/\battempts?\s+remaining\b/i);
  });
});

describe('DriverLoginPage — reachable by one thumb', () => {
  it('puts the 44px floor utility on every control on the screen', () => {
    mockTrpc({ 'driver.login': DRIVER });
    renderLogin();

    const controls = [
      ...screen.getAllByRole('button'),
      screen.getByLabelText(/driver code/i),
      screen.getByLabelText(/^pin$/i),
    ];
    expect(controls.length).toBeGreaterThan(13); // 10 digits + delete + clear + toggle + submit
    const missing = controls
      .filter((el) => !el.className.split(/\s+/).includes('tap-target'))
      .map((el) => el.getAttribute('aria-label') ?? el.textContent ?? el.id);
    expect(missing).toEqual([]);

    /*
     * And the 56px class on top of the 44px floor — `h-14`, which is what
     * the design doc asks the driver screens' real targets to be. The
     * CLASS is what jsdom can see; the pixels are Task 14's.
     *
     * The show/hide toggle is excluded and checked separately BECAUSE IT
     * HAS NO HEIGHT CLASS: it is `absolute inset-y-0` inside the `h-14`
     * PIN field, so its 56px comes from stretching to that field. jsdom
     * resolves no layout, so it cannot confirm that — asserting `h-14` on
     * it would mean adding a redundant class to satisfy a test, and
     * claiming the height was proved would be the lie this suite is being
     * cleaned of.
     */
    const toggle = screen.getByLabelText(/(show|hide) pin/i);
    const toggleClasses = toggle.className.split(/\s+/);
    expect(toggleClasses).toContain('inset-y-0');
    expect(toggleClasses).toContain('w-14');

    const shortOfFiftySix = controls
      .filter((el) => el !== toggle)
      .filter((el) => !el.className.split(/\s+/).includes('h-14'))
      .map((el) => el.getAttribute('aria-label') ?? el.textContent ?? el.id);
    expect(shortOfFiftySix).toEqual([]);
  });

  it('keeps the pad in its own group below the identity field', () => {
    mockTrpc({ 'driver.login': DRIVER });
    renderLogin();

    // A group, so a screen reader announces the keypad as one thing — and
    // so the pad's position in the DOM is assertable at all. Where it lands
    // on a 360px screen is not something jsdom can see; which side of the
    // identity field it is on, it is.
    const pad = screen.getByRole('group', { name: /pin keypad/i });
    expect(within(pad).getAllByRole('button')).toHaveLength(12);

    const code = screen.getByLabelText(/driver code/i);
    expect(code.compareDocumentPosition(pad) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });
});

describe('DriverLayout', () => {
  it('gives a driver a skip link, the portal name and a way out', async () => {
    mockTrpc({ 'driver.logout': { ok: true } });
    const user = userEvent.setup();
    render(
      <TrpcProviders>
        <MemoryRouter initialEntries={['/driver']}>
          <Routes>
            <Route path="/driver" element={<DriverLayout />}>
              <Route index element={<p>today</p>} />
            </Route>
            <Route path="/driver/login" element={<p>driver sign-in</p>} />
          </Routes>
        </MemoryRouter>
      </TrpcProviders>,
    );

    expect(screen.getByRole('link', { name: /skip to main content/i })).toBeInTheDocument();
    expect(screen.getByText('today')).toBeInTheDocument();

    /*
     * The portal name, which the test's own title claims. The BRAND, not
     * the legal operator: this is a working screen, not a receipt
     * (CLAUDE.md "Brand vs legal entity"). The header is `h-16` — the
     * class, not the pixels.
     */
    const name = screen.getByText(`${SITE.name} drivers`);
    expect(name).toBeInTheDocument();
    expect(name.parentElement!.className.split(/\s+/)).toContain('h-16');

    await user.click(screen.getByRole('button', { name: /sign out/i }));
    await screen.findByText('driver sign-in');
  });
});
