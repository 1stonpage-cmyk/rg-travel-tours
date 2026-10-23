/**
 * Week 6, Task 9 — the driver portal shell and its sign-in screen.
 *
 * `server/src/__tests__/driver-auth.test.ts` and `driver-lockout.test.ts`
 * prove the policy: five failures lock a driver out, each further lockout in
 * the same day lasts longer (15 → 30 → 60 minutes, capped, and never
 * terminal — owner decision 2026-10-23), and a wrong code and a wrong PIN are
 * refused byte-identically. This file proves the SCREEN — and almost all of
 * what it proves is words, because on this screen the words are the feature:
 *
 *  - one generic sentence for a refused pair, naming neither half;
 *  - ONE sentence for a lockout, naming the schedule rather than a single
 *    number and offering the office as the shortcut it now is. Until
 *    2026-10-23 there were TWO — "Locked for 15 minutes" and "Ask the office
 *    to reset your PIN" — because a lockout could be terminal; it cannot be
 *    now, so waiting is always the driver's next action and the second
 *    sentence went with the refusal it belonged to;
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

  /**
   * REWRITTEN for owner decision 2026-10-23 (Q1). It used to assert the
   * sentence read `locked for 15 minutes` — true while fifteen was the only
   * lockout length there was. The lockout now backs off (15 → 30 → 60 minutes
   * inside a day), so a flat promise of fifteen has a driver trying again at
   * minute sixteen, being refused, and deciding the portal is broken.
   *
   * What the sentence must do now: name the schedule, offer the office, and
   * stay amber, because waiting is still what fixes it.
   */
  it('tells a locked-out driver the lockout can be longer than fifteen minutes, in amber', async () => {
    mockTrpcError('driver.login', 'FORBIDDEN', 'locked');
    const user = userEvent.setup();
    renderLogin();
    await signIn(user);

    const alert = await screen.findByRole('alert');
    const text = alert.textContent ?? '';
    expect(text).toMatch(/15 minutes/i);
    // The half that would be missing from a copy of the OLD sentence: it can
    // be longer, and a driver who only reads "15 minutes" is misled.
    expect(text).toMatch(/longer if it keeps happening/i);
    // The office can now help without costing the driver their PIN, which is
    // the fact `admin.drivers.unlock` was added for.
    expect(text).toMatch(/without changing your PIN/i);
    // Amber, because it clears by itself (CLAUDE.md: warnings are amber).
    expect(alert.className).toMatch(/\bbg-amber-50\b/);
    expect(alert.className).toMatch(/\btext-amber-900\b/);
  });

  /**
   * REPLACES `'tells a driver who needs a dispatcher to ring the office, and
   * never to wait'`, which asserted a second, `needs_admin_unlock` sentence
   * reading "Ask the office to reset your PIN" and containing neither "15
   * minutes" nor "wait". That refusal no longer exists (owner decision
   * 2026-10-23): the lockout is never terminal, so there is no state in which
   * a driver must be told NOT to wait, and the copy for it is gone.
   *
   * This test is what stops it coming back as a fourth refusal with a
   * hand-written sentence: a reason the server cannot send must read as any
   * unrecognised reason does, not as its own instruction.
   */
  it('has no sentence of its own for the retired needs_admin_unlock refusal', async () => {
    mockTrpcError('driver.login', 'FORBIDDEN', 'needs_admin_unlock');
    const user = userEvent.setup();
    renderLogin();
    await signIn(user);

    const alert = await screen.findByRole('alert');
    expect(alert.textContent ?? '').not.toMatch(/reset your PIN/i);
    expect(alert).toHaveTextContent(/not answering just now/i);
  });

  /*
   * REWRITTEN (owner decision D3, 2026-10-16). This used to assert that a
   * `driver_inactive` refusal got its own "This code cannot sign in. Ring the
   * office." sentence. The server no longer sends that reason (a deactivated
   * driver is answered as `wrong_credentials`), so a sentence for it would
   * be unreachable copy that confirms an account is closed. A stale
   * `driver_inactive` now reads as any unrecognised reason does.
   */
  it('has no sentence of its own for a deactivated code', async () => {
    mockTrpcError('driver.login', 'FORBIDDEN', 'driver_inactive');
    const user = userEvent.setup();
    renderLogin();
    await signIn(user);

    const alert = await screen.findByRole('alert');
    expect(alert.textContent ?? '').not.toMatch(/cannot sign in/i);
    expect(alert).toHaveTextContent(/not answering just now/i);
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
