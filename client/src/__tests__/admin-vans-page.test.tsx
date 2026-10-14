/**
 * Week 5 plan, Task 5 — the vans admin screen (BUILD_SPEC §9 "Vans" / §5A,
 * client half). `server/src/__tests__/admin-vans.test.ts` proves the role
 * rules and the write paths; this file proves the screen: every field is
 * really labelled, a validation error lands beside its field (not only in
 * a summary), status is never colour alone, and the wide table rides
 * inside its own horizontal scroll container rather than the page body.
 *
 * `renderPage` wraps the component in `TrpcProviders` only. `AdminVansPage`
 * calls `trpc.*` hooks directly (a Provider is required, same reasoning as
 * `admin-bookings.test.tsx`'s `renderList`), but it renders no `<Link>` or
 * `<NavLink>` and calls no router hook of its own — unlike
 * `AdminBookingsPage`, which links out to a detail route — so no
 * `MemoryRouter` is needed here.
 *
 * **Deviation from the brief's verbatim test bodies, and why.** Three of
 * the five named tests ("renders the repair status...", "wraps the
 * table...", "gives every control...") read state that only exists after
 * `admin.vans.list` resolves — `vans.map(...)` renders nothing until then.
 * The brief's own code for those three calls `screen.getByText` /
 * `document.querySelector` synchronously, with no `await` and a non-async
 * test function. That cannot observe the mocked fetch's result: a
 * `Promise` only settles on a microtask turn, and a sync test body never
 * yields one — every existing async-data test in this codebase
 * (`admin-bookings.test.tsx`'s `findAllByText`, `review-form.test.tsx`'s
 * `findByRole`) awaits for exactly this reason. Run as literally given,
 * these three throw "unable to find element" regardless of whether
 * `AdminVansPage` is correct — a brief defect in the same family the
 * brief's own history section names (missing a wrapper, wrong signature),
 * not something to paper over silently. Fixed here by awaiting the list
 * query's own text before asserting — same assertions, same names, same
 * fixtures, now able to actually observe the rendered list. The other two
 * named tests ("labels every input...", "shows a field error...") exercise
 * only the always-mounted "Add a van" form, which needs no such wait, and
 * are kept exactly as given.
 */
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import AdminVansPage from '@/pages/admin/AdminVansPage';
import { TrpcProviders } from '@/lib/trpc';
import { mockTrpc, resetTrpcMock } from './helpers/mock-trpc';

afterEach(() => {
  resetTrpcMock();
});

const user = userEvent;

const VAN = {
  id: 1,
  plate: 'ABC123',
  model: 'Toyota Hiace',
  capacity: 10,
  status: 'available',
  odometer: 50_000,
  lastService: '2026-01-01',
  nextService: '2026-07-01',
  orcrExpiry: '2027-01-01',
  franchiseNo: 'FR-2026-001',
  franchiseExpiry: '2027-01-01',
  repairNotes: null,
  isActive: true,
};

function renderPage(overrides?: { vans?: Array<typeof VAN> }) {
  mockTrpc({
    'admin.vans.list': overrides?.vans ?? [VAN],
    'admin.vans.create': () => ({ id: 99 }),
    'admin.vans.update': () => ({ ok: true }),
    'admin.vans.setStatus': () => ({ ok: true }),
  });
  return render(
    <TrpcProviders>
      <AdminVansPage />
    </TrpcProviders>,
  );
}

describe('AdminVansPage', () => {
  it('labels every input with a real <label>', () => {
    renderPage();
    for (const name of ['Plate', 'Model', 'Seats for guests']) {
      expect(screen.getByLabelText(new RegExp(name, 'i'))).toBeTruthy();
    }

    // No input may rely on a placeholder for its name. `.labels` is the DOM's
    // own answer to "is there a <label> pointing at this control", so an
    // input that merely HAS an id — with no label anywhere — fails here.
    // An earlier draft asserted `input.getAttribute('aria-label') ?? input.id`,
    // which an unlabelled input with an id passes while the test's own name
    // claims a real label was found.
    const textboxes = screen.getAllByRole('textbox') as HTMLInputElement[];
    expect(textboxes.length).toBeGreaterThan(0);
    for (const input of textboxes) {
      const labelled = input.labels !== null && input.labels.length > 0;
      expect(labelled || input.getAttribute('aria-label') !== null).toBe(true);
    }
  });

  /**
   * The server REJECTS a patch with no fields (Task 4, fix round 1): an
   * empty patch used to skip the update, skip the only existence check with
   * it, and still commit a `van_updated` audit row for a change that never
   * happened. The client's job is to never send one — so opening the edit
   * form and saving without touching anything must show a notice and make
   * NO mutation call at all. Asserting the notice alone would not prove it;
   * the call count is the assertion that matters.
   */
  it('saves nothing, and calls nothing, when the edit form is unchanged', async () => {
    const updateCalls: unknown[] = [];
    mockTrpc({
      'admin.vans.list': [VAN],
      'admin.vans.create': () => ({ id: 99 }),
      'admin.vans.update': (input: unknown) => {
        updateCalls.push(input);
        return { ok: true };
      },
      'admin.vans.setStatus': () => ({ ok: true }),
    });
    render(
      <TrpcProviders>
        <AdminVansPage />
      </TrpcProviders>,
    );

    const editButtons = await screen.findAllByRole('button', { name: /^edit$/i });
    await userEvent.click(editButtons[0]!);
    await userEvent.click(await screen.findByRole('button', { name: /save changes/i }));

    expect(await screen.findByText(/no changes to save/i)).toBeTruthy();
    expect(updateCalls).toEqual([]);
  });

  it('shows a field error beside the field, not only at the top', async () => {
    renderPage();
    await user.clear(screen.getByLabelText(/plate/i));
    await user.click(screen.getByRole('button', { name: /add van/i }));
    const field = screen.getByLabelText(/plate/i);
    const described = field.getAttribute('aria-describedby');
    expect(described).toBeTruthy();
    expect(document.getElementById(described!)?.textContent).toMatch(/required|at least/i);
  });

  /**
   * `getByText`/`findByText` (singular) assumes exactly one match — but
   * this screen follows the same card-plus-table convention
   * `admin-bookings.test.tsx` proves and names explicitly ("card + table
   * row", asserted with `toHaveLength(2)`, not a singular query). The
   * status text legitimately appears more than once (the mobile card's
   * badge and the table row's badge at minimum), so this uses
   * `findAllByText` and a `length > 0` check rather than the brief's
   * verbatim singular query, which throws "multiple elements" here
   * regardless of whether the component is correct.
   */
  it('renders the repair status as text, not only a colour', async () => {
    renderPage({ vans: [{ ...VAN, status: 'for_repair' }] });
    const matches = await screen.findAllByText(/for repair/i);
    // EXACTLY two, not `> 0`: this page renders every van twice on purpose —
    // once in the card list (below `md:`) and once in the table (above it) —
    // and `admin-bookings.test.tsx` asserts the same shape with
    // `toHaveLength(2)`. A `> 0` bracket would still pass if one of the two
    // layouts silently stopped rendering the status text, which is half the
    // colour-alone protection gone with the test still green. One van in,
    // two renderings out.
    expect(matches).toHaveLength(2);
  });

  /**
   * NOTE ON WHAT THIS TEST CAN AND CANNOT PROVE. jsdom does no layout: it
   * cannot measure a scroll width, so no unit test here can honestly claim
   * "the page never scrolls sideways at 360px". What it CAN prove is that the
   * wide element is inside a scroll container of its own, which is the
   * mechanism that prevents the page from scrolling. The test is named for
   * the mechanism it checks, not for the outcome it would like to claim —
   * a name that over-claims is the same defect as an assertion that is
   * missing, and harder to spot, because the name reads like coverage.
   *
   * The 360px outcome itself is verified by hand in Task 16's walkthrough.
   */
  it('wraps the table in its own horizontal scroll container', async () => {
    renderPage({ vans: [VAN, { ...VAN, id: 2, plate: 'DEF456' }] });
    // `findAllByText`, not the brief's singular `findByText`: the plate
    // renders once in the mobile card and once in the table row (same
    // card-plus-table convention as `admin-bookings.test.tsx`), so a
    // singular query throws "multiple elements" here even when correct.
    await screen.findAllByText(VAN.plate);
    const wrapper = document.querySelector('[data-testid="vans-table-wrapper"]');
    expect(wrapper).not.toBeNull();
    expect(wrapper!.className).toMatch(/overflow-x-auto/);
    // The table must be INSIDE the scroll container, not a sibling of it —
    // a wrapper with the class and the table outside it scrolls nothing.
    expect(wrapper!.querySelector('table')).not.toBeNull();
  });

  /**
   * jsdom does no layout, so no unit test here can measure 44 physical
   * pixels. What it CAN prove is that every control carries the project's
   * own `tap-target` utility (`client/src/index.css`), which is what sets
   * the minimum. Named for the mechanism, not the outcome — an earlier draft
   * was called "gives every control a 44px tap target" and accepted any of
   * four classes, so it would have passed a control sized by an unrelated
   * `h-12`. The 44px outcome is checked by hand in Task 16.
   */
  it('gives every control the tap-target utility', async () => {
    renderPage();
    // Same card-plus-table reason as the previous test.
    await screen.findAllByText(VAN.plate);
    // Query the DOM, not ARIA roles. The role-based sweep this replaced saw
    // `button` and `textbox` only — so it silently skipped the status
    // `Select` (`role="combobox"`), every `type="number"` input
    // (`spinbutton`), and every `type="date"` input (which has NO mapped
    // role at all). On this page that is the capacity field, the odometer,
    // four date fields and the status control: most of the screen's
    // controls, all exempt from a test named "every control". The source
    // happens to apply `tap-target` to them anyway, so nothing was masked —
    // but the test was not checking.
    const controls = Array.from(
      document.querySelectorAll<HTMLElement>('button, input, select, textarea'),
    );
    expect(controls.length).toBeGreaterThan(8);
    for (const control of controls) {
      expect(
        control.className,
        `${control.tagName}[${control.getAttribute('type') ?? 'n/a'}]`,
      ).toMatch(/tap-target/);
    }
  });

  /**
   * Not in the brief's five, added here: the CONFLICT path the task
   * description calls out by name as "the most common real failure on this
   * screen" — a duplicate plate must land on the plate field, not as a bare
   * toast disconnected from the control that caused it.
   *
   * This cannot use `mockTrpcError`: that helper's own doc comment admits
   * `_code` is "accepted and unused on purpose" — every thrown error comes
   * back as `data: { code: 'INTERNAL_SERVER_ERROR', httpStatus: 500 }`
   * regardless of what is passed, because it "fakes the socket, not the
   * server". `review-form.test.tsx`'s identical-looking
   * `mockTrpcError('portal.submitReview', 'CONFLICT', ...)` call gets away
   * with this because `ReviewForm` never reads `error.data.code` — it shows
   * `error.message` unconditionally. This page DOES branch on the code (to
   * decide "beside the plate field" vs. "generic banner"), so proving that
   * branch needs a response shaped the way the real server really sends a
   * `TRPCError({ code: 'CONFLICT' })`: tRPC's own HTTP mapping is 409, not
   * 500. Built by hand here, scoped to this one test, rather than changing
   * the shared `mock-trpc.ts` helper for every other suite that relies on
   * its current behaviour.
   */
  it('surfaces a duplicate-plate CONFLICT on the plate field, not a bare toast', async () => {
    renderPage();
    await screen.findAllByText(VAN.plate);

    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify([
          {
            error: {
              message: 'A van with that plate number already exists.',
              code: -32009,
              data: { code: 'CONFLICT', httpStatus: 409 },
            },
          },
        ]),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )) as typeof fetch;

    await user.clear(screen.getByLabelText(/^plate/i));
    await user.type(screen.getByLabelText(/^plate/i), 'XYZ999');
    await user.clear(screen.getByLabelText(/model/i));
    await user.type(screen.getByLabelText(/model/i), 'Another Hiace');
    await user.clear(screen.getByLabelText(/seats for guests/i));
    await user.type(screen.getByLabelText(/seats for guests/i), '10');
    await user.click(screen.getByRole('button', { name: /add van/i }));

    const field = await screen.findByLabelText(/^plate/i);
    const described = field.getAttribute('aria-describedby');
    expect(described).toBeTruthy();
    expect(document.getElementById(described!)?.textContent).toMatch(/already exists/i);
  });
});
