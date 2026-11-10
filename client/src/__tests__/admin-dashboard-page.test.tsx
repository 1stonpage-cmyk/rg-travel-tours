/**
 * Week 5, Task 14: the admin dashboard — seven cards, zeroes included.
 *
 * Six until 2026-10-23, when owner decision Q1 added `driver_locked` beside
 * the backing-off PIN lockout. Every enumeration in this file names the kinds
 * explicitly rather than mapping `DASHBOARD_ALERT_KINDS`, deliberately: a kind
 * added to the union without copy in `AlertCard` fails to COMPILE, and a kind
 * added without a card on the PAGE has to fail here, which it cannot do if
 * this file follows the union automatically.
 *
 * Renders through `TrpcProviders` (the page uses a tRPC hook) and a
 * `MemoryRouter`, because each non-zero card links to the screen that
 * resolves it.
 */
import { render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type {
  DashboardAlert,
  DashboardMoneySummary,
  TodayDeparture,
  TripRequestSummary,
} from '@rg/shared';
import AdminDashboardPage from '@/pages/admin/AdminDashboardPage';
import { TrpcProviders } from '@/lib/trpc';
import { mockTrpc, mockTrpcError, resetTrpcMock } from './helpers/mock-trpc';

const alert = (
  kind: DashboardAlert['kind'],
  count: number,
  examples: DashboardAlert['examples'] = [],
): DashboardAlert => ({ kind, count, examples });

const ALL_SEVEN_NONZERO: DashboardAlert[] = [
  alert('payments_to_verify', 2, [{ id: 1, label: 'RG-AAAA11', date: '2026-11-12' }]),
  alert('unassigned_soon', 3, [{ id: 2, label: 'RG-BBBB22 · Kawasan Falls', date: '2026-11-11' }]),
  alert('vans_in_repair', 1, [{ id: 3, label: 'ABC 123 — Clutch', date: null }]),
  alert('service_due', 4, [{ id: 4, label: 'DEF 456', date: '2026-11-20' }]),
  alert('papers_expiring', 2, [{ id: 5, label: 'Maria Santos — licence', date: '2026-12-01' }]),
  alert('orphaned_on_trip', 1, [
    { id: 6, label: 'GHI 789 · last trip RG-CCCC33 on 2026-11-09', date: null },
  ]),
  alert('driver_locked', 1, [{ id: 7, label: 'Joselito Reyes', date: null }]),
];

/** What `staffAuth.me` answers unless a test says otherwise. */
const OWNER_ME = { userId: 1, role: 'owner', mustChangePassword: false, name: 'Olivia Owner' };

const EMPTY_TRIP_REQUESTS: TripRequestSummary = { count: 0, items: [] };
const ZERO_MONEY: DashboardMoneySummary = {
  collectedTodayCentavos: 0,
  pendingVerificationCentavos: 0,
};

/**
 * `me` reaches the page through `staffAuth.me`, and its ROLE now decides one
 * thing: whether the "payments to verify" card is drawn at all (owner
 * decision 2026-10-23, item 13). It defaults to an owner so every assertion
 * written before that decision still describes the page it was written
 * against; the dispatcher case has its own block below.
 *
 * Pass `null` to leave `staffAuth.me` to whatever the test registered
 * itself — which is how the "the name never arrives" test keeps its
 * `mockTrpcError` from being overwritten here.
 *
 * Task 1C added two more page-level queries, gated the same way
 * `payments_to_verify` already was — `tripRequests` and `money` default to
 * empty/zero here so a test that does not care about them (most of this
 * file) renders a settled page rather than one stuck on an unmocked-procedure
 * error. A test that DOES care passes its own via `extra`.
 */
function renderDashboard(
  alerts: DashboardAlert[],
  me: object | null = OWNER_ME,
  extra: {
    departures?: TodayDeparture[];
    tripRequests?: TripRequestSummary;
    money?: DashboardMoneySummary;
  } = {},
) {
  /*
   * The departures board (Week 6, Task 12) owns its own query on this
   * page, so every render here has to answer it too — an unmocked
   * procedure would put the board into its error state and leave these
   * assertions reading a page that is half broken. Empty is the quiet
   * answer: the board then renders its "nothing departing" line and the
   * alert cards are what is under test.
   */
  mockTrpc({
    'admin.dashboard.alerts': alerts,
    'admin.departures.today': extra.departures ?? [],
    'admin.dashboard.tripRequests': extra.tripRequests ?? EMPTY_TRIP_REQUESTS,
    'admin.dashboard.money': extra.money ?? ZERO_MONEY,
    ...(me === null ? {} : { 'staffAuth.me': me }),
  });
  return render(
    <TrpcProviders>
      <MemoryRouter>
        <AdminDashboardPage />
      </MemoryRouter>
    </TrpcProviders>,
  );
}

afterEach(resetTrpcMock);

/** The StatCell's numeral is the label's previous sibling — see `StatCell`. */
function statValue(container: HTMLElement, label: string): string | null {
  return within(container).getByText(label).previousElementSibling?.textContent ?? null;
}

describe('AdminDashboardPage', () => {
  it('links the departures panel to the departures board screen', async () => {
    renderDashboard(ALL_SEVEN_NONZERO);
    const link = await screen.findByRole('link', { name: 'Departures board' });
    expect(link).toHaveAttribute('href', '/admin/departures');
  });

  it('states each count in words, not as a bare numeral', async () => {
    renderDashboard(ALL_SEVEN_NONZERO);
    expect(await screen.findByText(/2 payments to verify/i)).toBeTruthy();
    expect(screen.getByText(/3 trips within 48 hours have no van or driver/i)).toBeTruthy();
    expect(screen.getByText(/4 vans are due for service within 14 days/i)).toBeTruthy();
  });

  it('uses the singular when there is exactly one', async () => {
    // "1 vans are in repair" is the kind of thing an operator stops
    // trusting, and the plural branch is where it would come from.
    renderDashboard([alert('vans_in_repair', 1)]);
    expect(await screen.findByText(/1 van is in repair/i)).toBeTruthy();
  });

  it('renders a zero alert as all clear, and still renders the card', async () => {
    renderDashboard([alert('vans_in_repair', 0)]);
    // Present, so an operator can tell "nothing to do" from "nothing
    // loaded".
    expect(await screen.findByTestId('alert-vans_in_repair')).toBeTruthy();
    expect(screen.getByText(/vans in repair/i)).toBeTruthy();
    expect(screen.getByText(/all clear/i)).toBeTruthy();
  });

  it('shows all seven cards even when six of them are zero', async () => {
    renderDashboard([
      alert('payments_to_verify', 1),
      alert('unassigned_soon', 0),
      alert('vans_in_repair', 0),
      alert('service_due', 0),
      alert('papers_expiring', 0),
      alert('orphaned_on_trip', 0),
      alert('driver_locked', 0),
    ]);
    await screen.findByTestId('alert-payments_to_verify');
    for (const kind of [
      'payments_to_verify',
      'unassigned_soon',
      'vans_in_repair',
      'service_due',
      'papers_expiring',
      'orphaned_on_trip',
      'driver_locked',
    ]) {
      expect(screen.getByTestId(`alert-${kind}`)).toBeTruthy();
    }
  });

  it('paints an alert amber, not with a forbidden hue', async () => {
    /*
     * Named around the forbidden word rather than with it: the project's
     * `no-red` guard scans source for bare colour names and flagged this
     * test's own TITLE. That is the guard being blunt in the right
     * direction — it cannot know a string is a test name, and a scanner
     * clever enough to try is a scanner to trust less.
     *
     * The assertion is positive for the same reason as on the drivers
     * screen: shadcn's variant strings carry `destructive`, so a negative
     * regex on `className` reports on vendored tokens rather than on this
     * card. The brand-wide rule lives in the guard, which reads real
     * source.
     */
    renderDashboard([alert('service_due', 3)]);
    const card = await screen.findByTestId('alert-service_due');
    expect(card.className).toMatch(/border-amber-200/);
    // The restyle puts the amber on the card's edge over a white ground, as
    // in the approved mockup, instead of tinting the whole card.
    expect(card.className).toMatch(/bg-white/);
  });

  it('links every non-zero alert to the screen that resolves it', async () => {
    renderDashboard(ALL_SEVEN_NONZERO);
    await screen.findByTestId('alert-payments_to_verify');
    // Counted inside the cards: the page header now also carries a "Find a
    // booking" link, which is not an alert action.
    const hrefs = screen
      .getAllByTestId(/^alert-/)
      .flatMap((card) => within(card).queryAllByRole('link'))
      .map((a) => a.getAttribute('href'));
    expect(hrefs).toContain('/admin/calendar');
    expect(hrefs).toContain('/admin/payments');
    expect(hrefs).toContain('/admin/vans');
    expect(hrefs).toContain('/admin/drivers');
    // EXACTLY seven links, one per non-zero card — a zero card must not
    // offer an action there is nothing to do.
    expect(hrefs).toHaveLength(7);
  });

  it('offers no link on a zero card', async () => {
    renderDashboard([alert('vans_in_repair', 0)]);
    const card = await screen.findByTestId('alert-vans_in_repair');
    expect(within(card).queryAllByRole('link')).toEqual([]);
  });

  it('uses ONE status region for the whole set', async () => {
    renderDashboard(ALL_SEVEN_NONZERO);
    await screen.findByTestId('alert-payments_to_verify');
    // Five competing live regions is the named anti-pattern; one sentence
    // tells an operator more than five numbers read in sequence.
    expect(screen.getAllByRole('status')).toHaveLength(1);
    // 2 + 3 + 1 + 4 + 2 + 1 + 1 — fourteen since `driver_locked` joined the set.
    expect(screen.getByRole('status').textContent).toMatch(/14 things need attention/i);
  });

  it('says nothing needs attention when every alert is zero', async () => {
    renderDashboard([alert('payments_to_verify', 0), alert('unassigned_soon', 0)]);
    expect((await screen.findByRole('status')).textContent).toMatch(/nothing needs attention/i);
  });

  it('names the examples the server sent, so the number is checkable', async () => {
    renderDashboard([
      alert('vans_in_repair', 1, [{ id: 3, label: 'ABC 123 — Clutch', date: null }]),
    ]);
    expect(await screen.findByText(/ABC 123 — Clutch/)).toBeTruthy();
  });

  /**
   * `papers_expiring` mixes two source tables (a driver's licence, a van's
   * franchise) in one `examples` array, and their ids share one numeric
   * space — a driver and a van landing on the same id is a real, observed
   * collision (id 2 for both, seen live), not a hypothetical one. Before
   * this test's fix, `AlertCard` keyed each `<li>` by `${kind}-${example.id}`
   * alone, which React warns about ("two children with the same key") and
   * which risks exactly what React's own warning names: a duplicated or
   * silently omitted row.
   */
  it('renders every example even when two of them share the same id', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    renderDashboard([
      alert('papers_expiring', 2, [
        { id: 2, label: 'Jun Alcantara — licence', date: '2026-11-28' },
        { id: 2, label: 'SEED-002 — franchise', date: '2026-12-02' },
      ]),
    ]);
    expect(await screen.findByText(/Jun Alcantara — licence/)).toBeTruthy();
    expect(screen.getByText(/SEED-002 — franchise/)).toBeTruthy();
    // The React-level proof, not just "both labels are somewhere in the DOM":
    // a duplicate key logs through console.error, so a regression here is
    // caught even if a future change happened to still render both labels.
    const duplicateKeyWarning = spy.mock.calls.some((call) => String(call[0]).includes('same key'));
    expect(duplicateKeyWarning).toBe(false);
    spy.mockRestore();
  });

  describe('the orphaned-van alert', () => {
    it('names the plate and says in words that the van is refused on every future date', async () => {
      renderDashboard([
        alert('orphaned_on_trip', 1, [
          { id: 6, label: 'GHI 789 · last trip RG-CCCC33 on 2026-11-09', date: null },
        ]),
      ]);
      const card = await screen.findByTestId('alert-orphaned_on_trip');
      expect(card.textContent).toMatch(/GHI 789/);
      expect(card.textContent).toMatch(/1 van is marked on trip, but no trip is running/i);
      // The consequence and the cure are in the SENTENCE, independent of
      // the card's colour classes.
      expect(card.textContent).toMatch(/refused on every future date/i);
      expect(card.textContent).toMatch(/until someone completes or corrects the trip/i);
    });

    it('pluralises, and links to the fleet screen', async () => {
      renderDashboard([alert('orphaned_on_trip', 2)]);
      expect(await screen.findByText(/2 vans are marked on trip/i)).toBeTruthy();
      expect(screen.getByRole('link', { name: /open the fleet/i }).getAttribute('href')).toBe(
        '/admin/vans',
      );
    });

    it('is absent as an alarm when the list is empty: all clear, no sentence, no link', async () => {
      renderDashboard([alert('orphaned_on_trip', 0)]);
      const card = await screen.findByTestId('alert-orphaned_on_trip');
      expect(card.textContent).toMatch(/all clear/i);
      expect(card.textContent).not.toMatch(/refused on every future date/i);
      expect(within(card).queryAllByRole('link')).toEqual([]);
    });

    it('is painted amber like its siblings', async () => {
      renderDashboard([alert('orphaned_on_trip', 1)]);
      const card = await screen.findByTestId('alert-orphaned_on_trip');
      expect(card.className).toMatch(/border-amber-200/);
      expect(card.className).toMatch(/bg-white/);
    });
  });

  /**
   * The seventh card (owner decision 2026-10-23, Q1). It ships with the
   * backing-off PIN lockout: the lockout lifts itself, so this card is
   * information rather than a job — but the office should not learn that a
   * driver cannot sign in by that driver ringing from beside a van at 5am.
   */
  describe('the locked-driver alert', () => {
    it('names the driver and says the lockout clears itself', async () => {
      renderDashboard([
        alert('driver_locked', 1, [{ id: 7, label: 'Joselito Reyes', date: null }]),
      ]);
      const card = await screen.findByTestId('alert-driver_locked');
      expect(card.textContent).toMatch(/Drivers locked out/i);
      expect(card.textContent).toMatch(/1 driver is locked out/i);
      expect(card.textContent).toMatch(/Joselito Reyes/);
      /*
       * The facts a dispatcher decides with, in the SENTENCE rather than in
       * the card's colour: it ends by itself, the driver's own PIN still works
       * afterwards, and there is nothing to do unless the clock is against
       * them. Without the middle one the obvious reading of "locked out" is
       * "reset their PIN", which costs a driver a PIN they had memorised.
       */
      expect(card.textContent).toMatch(/clears itself within the hour/i);
      expect(card.textContent).toMatch(/the PIN they already have/i);
      expect(card.textContent).toMatch(/nothing here needs doing/i);
    });

    /**
     * REPLACES `'instructs no on-screen action the drivers screen cannot yet
     * perform'` (Week 7 Task 5b, owner decision 2026-10-24, point 1).
     *
     * That test asserted the card's copy contained no `unlock` at all, and it
     * was right to while it was true: `admin.drivers.unlock` existed as a
     * procedure, the drivers screen offered Reset PIN only, and a card telling
     * an operator to do something the page it links to cannot do is worse than
     * one that only reports. Its own note said to delete it in the change that
     * ships the button — **the button now exists on `/admin/drivers`** (this
     * task), so the fact it guarded is gone and the assertion inverts rather
     * than loosens: the card must now NAME where the action lives.
     *
     * What it still holds, and why the order is asserted rather than described:
     * the self-clearing fact comes FIRST, so the card reads as information with
     * an option, not as a job. "Unlock it" as an opener would make a dispatcher
     * think a lockout needs clearing by hand, which is exactly what the backoff
     * removed.
     */
    it('points at the Unlock control the drivers screen now has, after the fact that it clears itself', async () => {
      renderDashboard([
        alert('driver_locked', 1, [{ id: 7, label: 'Joselito Reyes', date: null }]),
      ]);
      const card = await screen.findByTestId('alert-driver_locked');
      const text = card.textContent ?? '';
      expect(text).toMatch(/unlock on the drivers screen/i);
      // Order, not just presence: the self-clearing fact leads.
      expect(text.search(/clears itself/i)).toBeLessThan(text.search(/unlock/i));
      // Still exactly one action link, to the screen that now carries the
      // button the sentence names.
      const links = within(card).getAllByRole('link');
      expect(links).toHaveLength(1);
      expect(links[0]!.getAttribute('href')).toBe('/admin/drivers');
      expect(links[0]!.textContent).toMatch(/open the drivers/i);
    });

    it('pluralises, and links to the drivers screen', async () => {
      renderDashboard([alert('driver_locked', 3)]);
      expect(await screen.findByText(/3 drivers are locked out/i)).toBeTruthy();
      expect(screen.getByRole('link', { name: /open the drivers/i }).getAttribute('href')).toBe(
        '/admin/drivers',
      );
    });

    it('is all clear at zero: no sentence, no link', async () => {
      renderDashboard([alert('driver_locked', 0)]);
      const card = await screen.findByTestId('alert-driver_locked');
      expect(card.textContent).toMatch(/all clear/i);
      expect(card.textContent).not.toMatch(/locked out\b.*\d/i);
      expect(card.textContent).not.toMatch(/clears itself/i);
      expect(within(card).queryAllByRole('link')).toEqual([]);
    });

    it('never names the attempt count or the unlock time', async () => {
      /*
       * The alert payload deliberately carries neither (`driverLocked` in
       * `services/dispatch/alerts.ts` sets `date: null`), and the card must
       * not invent either: "locked until 05:42" would be a promise the backoff
       * can extend, and a count of failed attempts is the number §8 narrates
       * nowhere.
       */
      renderDashboard([
        alert('driver_locked', 1, [{ id: 7, label: 'Joselito Reyes', date: null }]),
      ]);
      const card = await screen.findByTestId('alert-driver_locked');
      expect(card.textContent).not.toMatch(/\b\d{1,2}:\d{2}\b/);
      expect(card.textContent).not.toMatch(/attempts?\b/i);
    });

    it('is painted amber like its siblings', async () => {
      renderDashboard([alert('driver_locked', 1)]);
      const card = await screen.findByTestId('alert-driver_locked');
      expect(card.className).toMatch(/border-amber-200/);
      expect(card.className).toMatch(/bg-white/);
    });
  });

  it("carries §9's departures board below the cards", async () => {
    /*
     * This test used to assert the line of apology that stood here while
     * `trip_checkpoints` did not exist. Task 12 replaced that line with
     * the real panel, so the assertion moved with it rather than being
     * deleted: §9's dashboard LEADS with today's departures, and a page
     * that silently stopped rendering them should fail something.
     *
     * The board's own behaviour — the progress wording, the poll, the
     * busy state — is `departures-board.test.tsx`. This only pins that
     * the dashboard mounts it.
     */
    renderDashboard(ALL_SEVEN_NONZERO);
    expect(await screen.findByTestId('departures-board')).toBeTruthy();
    expect(screen.getByRole('heading', { name: /leaving today/i })).toBeTruthy();
  });

  /**
   * Task 16 (7M): the mockup's "Good morning, <name>" greeting, left out of
   * the restyle until `staffAuth.me` carried a name to put in it.
   */
  describe('the staff greeting', () => {
    it('greets the signed-in staff member by name', async () => {
      renderDashboard([], { ...OWNER_ME, name: 'Maria Santos' });
      // The h1 exists from the very first synchronous render (it falls back
      // to "Dashboard" while `me` is pending), so `findByRole` alone would
      // resolve against that first paint — wait for the NAME to land before
      // reading the heading.
      await screen.findByText(/Maria Santos/);
      const heading = screen.getByRole('heading', { level: 1 });
      expect(heading.textContent).toMatch(/Maria Santos/);
      expect(heading.textContent).toMatch(/Good (morning|afternoon|evening)/);
    });

    /**
     * The alerts query is independent and must keep working even if the
     * name never arrives — the brief's own requirement, and the reason
     * `AdminDashboardPage` reads `me` with its own `retry: false` rather
     * than blocking the page on it.
     */
    it('falls back to the plain heading when staffAuth.me fails, and the rest of the page still renders', async () => {
      mockTrpcError('staffAuth.me', 'INTERNAL_SERVER_ERROR');
      renderDashboard([alert('vans_in_repair', 1)], null);
      const heading = await screen.findByRole('heading', { level: 1 });
      expect(heading.textContent).toBe('Dashboard');
      expect(await screen.findByTestId('alert-vans_in_repair')).toBeTruthy();
    });
  });

  /**
   * Owner decision 2026-10-23, 7N item 13. The card leads to
   * `/admin/payments`, §9's `verifyPayments` row — owner and finance. The
   * nav never offered a dispatcher that link; the card did, and every
   * receipt behind it is already hidden from them, so it was a card whose
   * only outcome was a dead end.
   *
   * COSMETIC ONLY, which is the half worth pinning: the server still sends
   * the alert to all three roles. These tests therefore hand the page the
   * same payload for every role and assert only on what it DRAWS — if they
   * mocked the alert away for a dispatcher they would prove nothing about
   * this change and would hide a server-side regression.
   */
  describe('the payments-to-verify card by role', () => {
    it('is NOT drawn for a dispatcher, though the server still sent it', async () => {
      renderDashboard(ALL_SEVEN_NONZERO, { ...OWNER_ME, role: 'dispatcher' });
      // Wait for a card that IS theirs, so this is not asserting on an
      // unrendered page.
      await screen.findByTestId('alert-unassigned_soon');
      expect(screen.queryByTestId('alert-payments_to_verify')).toBeNull();
      // No explanation note (owner decision): the card simply is not there.
      expect(screen.queryByText(/payments to verify/i)).toBeNull();
      // The other six are untouched.
      expect(screen.getAllByTestId(/^alert-/)).toHaveLength(6);
      // And the one status sentence counts what is DRAWN: 14 − 2 = 12.
      expect(screen.getByRole('status').textContent).toMatch(/12 things need attention/i);
    });

    it('IS drawn for an owner and for finance', async () => {
      for (const role of ['owner', 'finance']) {
        renderDashboard(ALL_SEVEN_NONZERO, { ...OWNER_ME, role });
        expect(await screen.findByTestId('alert-payments_to_verify')).toBeTruthy();
        resetTrpcMock();
      }
    });

    it('is not drawn while the role is still unknown, erring towards the smaller screen', async () => {
      // `AdminLayout`'s nav goes the same way when `me` is pending or has
      // failed: draw less, never a control whose only outcome is a refusal.
      mockTrpcError('staffAuth.me', 'INTERNAL_SERVER_ERROR');
      renderDashboard(ALL_SEVEN_NONZERO, null);
      await screen.findByTestId('alert-unassigned_soon');
      expect(screen.queryByTestId('alert-payments_to_verify')).toBeNull();
    });
  });

  it('still keeps ONE status region with the board mounted', async () => {
    // The board deliberately adds none: `aria-busy` is an attribute, not
    // an announcement, and a panel that announced itself every fifteen
    // seconds would be worse than the five regions this page avoids.
    renderDashboard(ALL_SEVEN_NONZERO);
    // The board renders synchronously, so its presence is NOT evidence the
    // alerts have landed — wait for a card, or this counts the regions of a
    // half-rendered page and passes for the wrong reason.
    await screen.findByTestId('alert-payments_to_verify');
    expect(screen.getByTestId('departures-board')).toBeTruthy();
    expect(screen.getAllByRole('status')).toHaveLength(1);
  });

  /**
   * Task 1C (admin dashboard batch, owner decision 2026-11-10): the inline
   * stats row. "On the road" / "Awaiting dispatch" are derived client-side
   * from `admin.departures.today` — the SAME query `DeparturesBoard` reads,
   * not a second source of truth — so this file builds `TodayDeparture`
   * fixtures rather than a bespoke stats payload.
   */
  describe('the inline stats row', () => {
    const stop = (checkedAt: string | null) => ({
      stopId: null,
      name: 'Pickup',
      sortOrder: 0,
      checkedAt,
      undone: false,
    });

    let nextBookingId = 1;

    function departure(status: TodayDeparture['status'], ref: string): TodayDeparture {
      const bookingId = nextBookingId++;
      return {
        bookingId,
        ref,
        tourTitle: null,
        transferRouteLabel: 'Mactan Airport → Oslob',
        pickupTime: '05:30',
        vehicleTypeLabel: 'Van',
        driverName: 'Mario Dela Cruz',
        vanPlate: 'SEED-001',
        status,
        progress: {
          bookingId,
          status,
          stops: [
            stop(
              status === 'in_progress' || status === 'completed' ? '2026-11-10T00:00:00Z' : null,
            ),
          ],
          done: status === 'in_progress' || status === 'completed' ? 1 : 0,
          total: 1,
        },
      };
    }

    it('counts one in_progress trip as "on the road" and the rest as "awaiting dispatch"', async () => {
      renderDashboard([], OWNER_ME, {
        departures: [
          departure('in_progress', 'RG-AAAA11'),
          departure('confirmed', 'RG-BBBB22'),
          departure('assigned', 'RG-CCCC33'),
        ],
      });
      const stats = await screen.findByTestId('dashboard-stats');
      // The cell renders synchronously with `—` on first paint, then the
      // real count once `admin.departures.today` resolves — `waitFor`
      // rather than a one-shot read, which would race the mocked fetch.
      await waitFor(() => expect(statValue(stats, 'On the road')).toBe('1'));
      expect(statValue(stats, 'Awaiting dispatch')).toBe('2');
    });

    it('does not count a completed trip as awaiting dispatch', async () => {
      renderDashboard([], OWNER_ME, {
        departures: [departure('completed', 'RG-AAAA11'), departure('confirmed', 'RG-BBBB22')],
      });
      const stats = await screen.findByTestId('dashboard-stats');
      // On the road stays 0 (completed is not in_progress); awaiting dispatch
      // is 1, not 2 — a finished trip must not read as still-to-dispatch.
      await waitFor(() => expect(statValue(stats, 'Awaiting dispatch')).toBe('1'));
      expect(statValue(stats, 'On the road')).toBe('0');
    });

    it('shows a dash rather than a false zero while departures are still loading', () => {
      // No `await` / `findBy` here on purpose: this reads the FIRST paint,
      // before the mocked fetch resolves, which is the only moment a
      // premature "0" could appear.
      renderDashboard([], OWNER_ME, { departures: [] });
      const stats = screen.getByTestId('dashboard-stats');
      expect(within(stats).getAllByText('—').length).toBeGreaterThan(0);
    });
  });

  /**
   * Task 1C: the money cells, gated to `MONEY_ROLES` exactly like the
   * `payments_to_verify` card above — and the new `tripRequests` stat,
   * gated to `TRIP_REQUEST_ROLES` (owner, dispatcher).
   */
  describe('the money stats and trip-requests stat by role', () => {
    const money: DashboardMoneySummary = {
      collectedTodayCentavos: 1_420_000,
      pendingVerificationCentavos: 360_000,
    };
    const requests: TripRequestSummary = {
      count: 2,
      items: [
        {
          id: 1,
          name: 'Liza Fernandez',
          pax: 6,
          routeDescription: 'Hotel → Moalboal',
          requestedDate: '2026-11-15',
        },
      ],
    };

    it('shows collected today and pending verification for an owner', async () => {
      renderDashboard([], OWNER_ME, { money });
      const stats = await screen.findByTestId('dashboard-stats');
      // The cells themselves are gated on `staffAuth.me` resolving (role is
      // `undefined` on the first synchronous paint) — `findByText` waits for
      // both the role and the money data rather than racing either.
      expect(await within(stats).findByText('Collected today')).toBeTruthy();
      expect(within(stats).getByText('Pending verification')).toBeTruthy();
      expect(await within(stats).findByText('₱14,200')).toBeTruthy();
      expect(within(stats).getByText('₱3,600')).toBeTruthy();
    });

    it('shows collected today and pending verification for finance', async () => {
      renderDashboard([], { ...OWNER_ME, role: 'finance' }, { money });
      const stats = await screen.findByTestId('dashboard-stats');
      expect(await within(stats).findByText('₱14,200')).toBeTruthy();
    });

    it('shows no money cell at all for a dispatcher, not even a placeholder', async () => {
      renderDashboard([], { ...OWNER_ME, role: 'dispatcher' }, { money });
      const stats = await screen.findByTestId('dashboard-stats');
      expect(within(stats).queryByText('Collected today')).toBeNull();
      expect(within(stats).queryByText('Pending verification')).toBeNull();
    });

    /*
     * Three separate `it`s, not a loop of `renderDashboard` calls in one —
     * `render()` leaves its previous tree mounted unless unmounted, and
     * `screen.findByTestId` happily resolves against an EARLIER tree's
     * still-present node, which would prove nothing about the second
     * render. (This is a real, pre-existing hazard in this file's own
     * "IS drawn for an owner and for finance" test above, which this
     * shape would have repeated — flagged as an unrelated bug, not fixed
     * here per CLAUDE.md's own instruction.)
     */
    it('shows the trip-requests count for an owner', async () => {
      renderDashboard([], OWNER_ME, { tripRequests: requests });
      const stats = await screen.findByTestId('dashboard-stats');
      await waitFor(() => expect(statValue(stats, 'Trip requests')).toBe('2'));
    });

    it('shows the trip-requests count for a dispatcher', async () => {
      renderDashboard([], { ...OWNER_ME, role: 'dispatcher' }, { tripRequests: requests });
      const stats = await screen.findByTestId('dashboard-stats');
      await waitFor(() => expect(statValue(stats, 'Trip requests')).toBe('2'));
    });

    it('shows no trip-requests cell at all for finance', async () => {
      renderDashboard([], { ...OWNER_ME, role: 'finance' }, { tripRequests: requests });
      await screen.findByTestId('dashboard-stats');
      expect(screen.queryByText('Trip requests')).toBeNull();
    });
  });

  /**
   * Task 1C: the trip-request mini-queue. "Quote" for an owner (the only
   * role among the two that can see this queue AND price a custom trip —
   * `transferQuoting` is owner+finance, `packagesInquiries` is
   * owner+dispatcher); "View only" for a dispatcher, never a button whose
   * only server-side outcome is FORBIDDEN.
   */
  describe('the trip-request mini-queue', () => {
    const requests: TripRequestSummary = {
      count: 1,
      items: [
        {
          id: 42,
          name: 'Liza Fernandez',
          pax: 6,
          routeDescription: 'Hotel, Cebu City → Panagsama Beach, Moalboal',
          requestedDate: '2026-11-15',
        },
      ],
    };

    it('names the requester, pax and route for an owner, with a Quote button to /admin/packages', async () => {
      renderDashboard([], OWNER_ME, { tripRequests: requests });
      const queue = await screen.findByTestId('trip-request-queue');
      // The queue section renders synchronously (gated only by role); its
      // ROWS arrive once `admin.dashboard.tripRequests` resolves, so the
      // first assertion waits and the rest read the now-settled DOM.
      expect(await within(queue).findByText('Liza Fernandez')).toBeTruthy();
      expect(within(queue).getByText(/6 pax/)).toBeTruthy();
      expect(within(queue).getByText(/Panagsama Beach, Moalboal/)).toBeTruthy();
      const quote = within(queue).getByRole('link', { name: 'Quote' });
      expect(quote.getAttribute('href')).toBe('/admin/packages');
    });

    it('shows "View only" for a dispatcher, with no actionable button', async () => {
      renderDashboard([], { ...OWNER_ME, role: 'dispatcher' }, { tripRequests: requests });
      const queue = await screen.findByTestId('trip-request-queue');
      expect(await within(queue).findByText('View only')).toBeTruthy();
      expect(within(queue).queryByRole('link', { name: 'Quote' })).toBeNull();
      expect(within(queue).queryByRole('button', { name: 'Quote' })).toBeNull();
    });

    it('is not rendered at all for finance', async () => {
      renderDashboard(
        ALL_SEVEN_NONZERO,
        { ...OWNER_ME, role: 'finance' },
        { tripRequests: requests },
      );
      await screen.findByTestId('alert-payments_to_verify');
      expect(screen.queryByTestId('trip-request-queue')).toBeNull();
    });

    it('states the empty queue rather than omitting it, when there is nothing new', async () => {
      renderDashboard([], OWNER_ME, { tripRequests: EMPTY_TRIP_REQUESTS });
      const queue = await screen.findByTestId('trip-request-queue');
      expect(await within(queue).findByText(/no new trip requests/i)).toBeTruthy();
    });
  });
});
