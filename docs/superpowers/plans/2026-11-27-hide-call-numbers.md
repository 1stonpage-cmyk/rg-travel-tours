# Hide Call Numbers Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an admin switch (`contact.showCallNumbers`, default `true`) that, when turned off, removes every "call or text this number" surface from the public site while leaving WhatsApp, Viber, email and Facebook working exactly as before.

**Architecture:** One new boolean field on the existing `contact` settings block (owner decision 2026-11-27). Three independent consumers read it, because three independent code paths currently show a phone number and none of them share a resolver:
1. **`server/src/content/settings.ts`** strips `phoneDisplay`/`phoneTel`/`altPhoneDisplay`/`altPhoneTel` from the public `settings.get` payload when the switch is off (defense in depth / explicit spec requirement — tested at the payload level).
2. **`server/src/seo/jsonld.ts`** gates `telephone` on the SAME boolean independently, because `travelAgencyNode` is fed from `readSettingBlock('contact')` — the raw block — not from the resolved public payload. These two paths do not share code and both must be changed.
3. **The actual on-screen phone numbers are static**, bundled into client JS from `client/src/lib/site.ts` (`SITE.contact.phone.*` / `SITE.contact.altPhone.*`). No existing component reads `settings.contact.phoneDisplay` to render a number — they all read the static `SITE` object. So hiding anything visually requires a *second*, separate change: gating the JSX in each component on `settings.contact.showCallNumbers`. Do not assume task 1A's payload change hides anything by itself — it doesn't, until 1C's render-gates are also done.

**Tech Stack:** React + TS + Vite + Tailwind v4 (client), Express + tRPC + Zod + Drizzle (server). No new libraries — the "switch" UI reuses the hand-rolled `role="switch"` toggle markup already used twice in `AdminSettingsPage.tsx` (no Radix Switch is installed).

**Spec:** This file is the spec — see the owner decision quoted in the task brief (2026-11-27): hide call/SMS numbers behind a site-wide switch; WhatsApp/Viber/email/Facebook keep working; WhatsApp/Viber deep links necessarily carry the number, which is accepted.

## Global Constraints

- Brand vs. legal entity stays separate (`SITE.name` vs `SITE.legalOperator`) — untouched by this work.
- **No red anywhere.** The switch is blue-on/grey-off, matching the existing toggle pattern. No new error states need colour.
- WhatsApp (`#25D366`/`#128C7E` hover) and Viber (`#7360F2`) pills stay **icon-only with `aria-label`**; any visible "WhatsApp"/"Viber" wording sits **outside** the pill in brand ink, never white-on-brand-colour.
- 44px (`size-11`/`h-11`) minimum tap targets; mobile-first, must work at 360px.
- `settings.write` validates before opening a transaction — unaffected, since `showCallNumbers` is just a new field inside the existing `contact` schema's existing validate-then-write path. No new code needed for this.
- **No new dependencies.**
- **Do NOT touch:** `client/src/pages/driver/DriverTripPage.tsx` (shows the *guest's* phone to the driver) or `client/src/components/portal/DriverCard.tsx` (shows the *driver's* phone to the guest/portal user). Both are out of scope by the task brief and confirmed by this plan's own `tel:` grep.
- **Do NOT touch** `coming-soon/index.html` or `scripts/check-contact-parity.mjs`. That page is static HTML with no settings access and cannot honour a database-driven switch; the parity guard runs inside `pnpm test` and requires the real numbers to stay in `client/src/lib/site.ts` byte-for-byte. Leave `site.ts`'s numbers exactly as they are — this plan only ever gates *whether a component renders them*, never the stored values themselves.
- Every new test must be proven able to fail (break the assertion, watch it go red, restore it) before being considered done.

---

### Task 1: Settings schema — `contact.showCallNumbers`

**Files:**
- Modify: `server/src/content/settings-schema.ts:308-325` (`contactSchema`)
- Test: `server/src/__tests__/settings.test.ts`

**Interfaces:**
- Produces: `contactSchema` now validates/parses a `showCallNumbers: boolean` field. `SettingsBlocks['contact']` (the inferred type every other file in this plan imports) now includes `showCallNumbers: boolean`, required on the parsed/output side, defaulted when absent on the input side.

- [ ] **Step 1: Write the failing test**

Add to `server/src/__tests__/settings.test.ts` (find the existing `describe` block that covers `contactSchema`/`SETTING_SCHEMAS.contact`, or add a new one near it):

```ts
describe('contact.showCallNumbers (owner decision 2026-11-27)', () => {
  it('defaults to true when a legacy stored block has no key', () => {
    const legacy = {
      address: 'Cebu City',
      tagline: 'Your Cebu guides',
      hoursNote: 'Daily',
      email: 'hello@example.test',
      phoneDisplay: '0917 000 0000',
      phoneTel: '639170000000',
      whatsapp: '639170000000',
      altPhoneDisplay: '',
      altPhoneTel: '',
      facebook: 'travelsugbo',
      motto: 'Explore Cebu',
      otherServices: { before: 'We also offer', link: 'transfers', after: 'on request.' },
      // no showCallNumbers key — simulates every row written before this task
    };
    const result = SETTING_SCHEMAS.contact.parse(legacy);
    expect(result.showCallNumbers).toBe(true);
  });

  it('parses an explicit false', () => {
    const block = {
      ...SETTINGS_BLOCKS_FIXTURE.contact,
      showCallNumbers: false,
    };
    const result = SETTING_SCHEMAS.contact.parse(block);
    expect(result.showCallNumbers).toBe(false);
  });
});
```

Check the top of `settings.test.ts` for how it imports `SETTING_SCHEMAS` and whatever the local full-contact fixture is called (it is used already around the `blocks.contact.email` assertions at line ~671) — reuse that fixture's name instead of inventing `SETTINGS_BLOCKS_FIXTURE` if a different name already exists in that file.

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @rg/server test -- settings.test.ts -t "showCallNumbers"`
Expected: FAIL — `result.showCallNumbers` is `undefined`, not `true`/`false` (the schema doesn't have the key yet).

- [ ] **Step 3: Add the field**

In `server/src/content/settings-schema.ts`, change `contactSchema`:

```ts
const contactSchema = z.object({
  address: z.string(),
  tagline: z.string(),
  hoursNote: z.string(),
  email: z.string(),
  phoneDisplay: z.string(),
  phoneTel: z.string(),
  whatsapp: z.string(),
  altPhoneDisplay: z.string(),
  altPhoneTel: z.string(),
  facebook: z.string(),
  motto: z.string(),
  otherServices: z.object({
    before: z.string(),
    link: z.string(),
    after: z.string(),
  }),
  /**
   * Admin switch (owner decision 2026-11-27): the owner works at sea and
   * cannot take calls or SMS, so guests must be steered to WhatsApp/Viber/
   * email/Facebook only. `.default(true)` is what makes a stored block
   * written before this field existed parse as "calls shown" — nothing
   * changes until an admin explicitly switches it off. See
   * `resolveContact()` in `content/settings.ts` for how the public payload
   * strips the four phone fields below when this is false, and
   * `travelAgencyNode()` in `seo/jsonld.ts` for the independent JSON-LD gate
   * (that path reads this raw block directly, not the resolved payload).
   */
  showCallNumbers: z.boolean().default(true),
});
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @rg/server test -- settings.test.ts -t "showCallNumbers"`
Expected: PASS

- [ ] **Step 5: Fix the fixtures `pnpm typecheck` will now flag**

`SettingsBlocks['contact']` (the type inferred from the schema) now requires `showCallNumbers: boolean` on every object typed against it. Add `showCallNumbers: true` to the `contact` object literal in:
- `server/src/db/seed-data.ts` (the `SEED_SETTINGS.contact` block, right after `altPhoneTel: '+639277378431',` around line 734)
- `client/src/__tests__/helpers/fixtures.ts` (the `SETTINGS_FIXTURE.contact` object, right after `otherServices: {...}` around line 225)
- `client/src/__tests__/admin-settings-page.test.tsx` (the local raw-blocks fixture's `contact` object, right after `otherServices: {...}` around line 137)

Each gets the literal `showCallNumbers: true,` — matching the schema default, not inventing a different value.

- [ ] **Step 6: Run the full server test suite for this file and the seed-parity guard**

Run: `pnpm --filter @rg/server test -- settings.test.ts seed-parity.test.ts`
Expected: PASS. `seed-parity.test.ts` does not assert on `showCallNumbers` (it mirrors `site.ts`'s static values, which this field has no counterpart for), so it should be unaffected — this run just confirms the seed fixture's new field didn't break the existing mirror assertions.

- [ ] **Step 7: Commit**

```bash
git add server/src/content/settings-schema.ts server/src/__tests__/settings.test.ts server/src/db/seed-data.ts client/src/__tests__/helpers/fixtures.ts client/src/__tests__/admin-settings-page.test.tsx
git commit -m "feat(server): add contact.showCallNumbers setting, default true"
```

---

### Task 2: Public payload — strip phone fields when off

**Files:**
- Modify: `server/src/content/settings.ts` (interface `SettingsPayload` around line 399; add a `resolveContact` function beside `resolvePermits`, line ~514; wire it into `toSettingsPayload` at line ~552)
- Test: `server/src/__tests__/settings.test.ts` (or wherever `toSettingsPayload` is already tested — check for an existing `describe('toSettingsPayload'...)` block first)

**Interfaces:**
- Consumes: `SettingsBlocks['contact']` (Task 1's output, now carries `showCallNumbers`).
- Produces: `PublicContact` type and `resolveContact(contact: SettingsBlocks['contact']): PublicContact`, exported from `server/src/content/settings.ts`. `SettingsPayload['contact']` becomes `PublicContact` instead of `SettingsBlocks['contact']`.

- [ ] **Step 1: Write the failing test**

Find (or add near) the test that already exercises `toSettingsPayload` in `server/src/__tests__/settings.test.ts`. Add:

```ts
describe('toSettingsPayload — contact.showCallNumbers (owner decision 2026-11-27)', () => {
  const baseContact = {
    address: 'Cebu City',
    tagline: 'Your Cebu guides',
    hoursNote: 'Daily',
    email: 'hello@example.test',
    phoneDisplay: '0917 000 0000',
    phoneTel: '639170000000',
    whatsapp: '639170000000',
    altPhoneDisplay: '0917 111 1111',
    altPhoneTel: '639171111111',
    facebook: 'travelsugbo',
    motto: 'Explore Cebu',
    otherServices: { before: 'We also offer', link: 'transfers', after: 'on request.' },
  };

  it('sends every phone field when showCallNumbers is true', () => {
    const blocks = { ...BLOCKS_FIXTURE, contact: { ...baseContact, showCallNumbers: true } };
    const payload = toSettingsPayload(blocks, new Date(), true, true);
    expect(payload.contact.phoneDisplay).toBe('0917 000 0000');
    expect(payload.contact.phoneTel).toBe('639170000000');
    expect(payload.contact.altPhoneDisplay).toBe('0917 111 1111');
    expect(payload.contact.altPhoneTel).toBe('639171111111');
    expect(payload.contact.whatsapp).toBe('639170000000');
  });

  it('strips all four phone fields when showCallNumbers is false, keeping whatsapp', () => {
    const blocks = { ...BLOCKS_FIXTURE, contact: { ...baseContact, showCallNumbers: false } };
    const payload = toSettingsPayload(blocks, new Date(), true, true);
    const serialized = JSON.stringify(payload.contact);
    expect(serialized).not.toContain('0917 000 0000');
    expect(serialized).not.toContain('639170000000'.slice(0, 6)); // no raw dialable digits either
    expect('phoneDisplay' in payload.contact).toBe(false);
    expect('phoneTel' in payload.contact).toBe(false);
    expect('altPhoneDisplay' in payload.contact).toBe(false);
    expect('altPhoneTel' in payload.contact).toBe(false);
    expect(payload.contact.whatsapp).toBe('639170000000');
    expect(payload.contact.showCallNumbers).toBe(false);
  });
});
```

Use whatever name the file's existing full-`SettingsBlocks` fixture already has instead of `BLOCKS_FIXTURE` — check the top of `settings.test.ts` for it (it must already exist, since `toSettingsPayload` needs every key).

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @rg/server test -- settings.test.ts -t "showCallNumbers"`
Expected: FAIL on the second test — `payload.contact.phoneDisplay` is still `'0917 000 0000'` because nothing strips it yet (the first test should already pass, since `contact: blocks.contact` currently passes every field through verbatim).

- [ ] **Step 3: Implement `resolveContact` and wire it in**

In `server/src/content/settings.ts`, add the type and function beside `resolvePermits` (after its closing brace, ~line 518):

```ts
/**
 * The public `contact` block (owner decision 2026-11-27, "hide call
 * numbers"). The four call/SMS fields are OPTIONAL here, not nullable —
 * when `showCallNumbers` is false they are omitted from the object
 * entirely ("must NOT send them to the browser at all"), not sent as
 * `null`. `whatsapp`/`email`/`facebook`/`address`/`hoursNote`/`tagline`/
 * `motto`/`otherServices` always pass through unchanged: WhatsApp/Viber
 * deep links necessarily carry a number, and that is accepted (see this
 * plan's header).
 */
export type PublicContact = Omit<
  SettingsBlocks['contact'],
  'phoneDisplay' | 'phoneTel' | 'altPhoneDisplay' | 'altPhoneTel'
> &
  Partial<
    Pick<SettingsBlocks['contact'], 'phoneDisplay' | 'phoneTel' | 'altPhoneDisplay' | 'altPhoneTel'>
  >;

export function resolveContact(contact: SettingsBlocks['contact']): PublicContact {
  if (contact.showCallNumbers) return contact;
  const { phoneDisplay, phoneTel, altPhoneDisplay, altPhoneTel, ...rest } = contact;
  return rest;
}
```

Change the `SettingsPayload` interface (line ~399):

```ts
  contact: PublicContact;
```

Change the assembly in `toSettingsPayload` (line ~552):

```ts
    contact: resolveContact(blocks.contact),
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @rg/server test -- settings.test.ts -t "showCallNumbers"`
Expected: PASS

- [ ] **Step 5: Typecheck**

Run: `pnpm --filter @rg/server typecheck` (or `pnpm typecheck` from root if there's no per-package script — check `package.json`)
Expected: PASS. If any other server file destructures `payload.contact.phoneTel` etc. assuming it's always a `string`, this is where it will surface — fix by optional-chaining at that call site, do not loosen `PublicContact` back to non-optional.

- [ ] **Step 6: Commit**

```bash
git add server/src/content/settings.ts server/src/__tests__/settings.test.ts
git commit -m "feat(server): strip call-number fields from the public settings payload when showCallNumbers is off"
```

---

### Task 3: JSON-LD — omit `telephone` independently

**Files:**
- Modify: `server/src/seo/jsonld.ts:155-176` (`travelAgencyNode`)
- Test: `server/src/__tests__/jsonld.test.ts`

**Interfaces:**
- Consumes: `AgencyInput.contact: SettingsBlocks['contact']` (raw block — unchanged type, now carries `showCallNumbers` per Task 1).
- Produces: `travelAgencyNode(...)`'s returned node omits `telephone` when `input.contact.showCallNumbers` is `false`.

- [ ] **Step 1: Write the failing test**

In `server/src/__tests__/jsonld.test.ts`, find the existing `describe('travelAgencyNode', ...)` block (line ~126) and the helper that builds a default `AgencyInput` (line ~86). Add:

```ts
it('omits telephone when contact.showCallNumbers is false (owner decision 2026-11-27)', () => {
  const node = travelAgencyNode({
    ...defaultAgencyInput(), // use whatever the file's existing helper is actually named
    contact: { ...defaultAgencyInput().contact, showCallNumbers: false },
  });
  expect(node.telephone).toBeUndefined();
  expect('telephone' in node).toBe(false);
});

it('still includes telephone when contact.showCallNumbers is true', () => {
  const node = travelAgencyNode({
    ...defaultAgencyInput(),
    contact: { ...defaultAgencyInput().contact, showCallNumbers: true },
  });
  expect(node.telephone).toBeTruthy();
});
```

Check the actual helper name/shape used around line 86 (it is not necessarily called `defaultAgencyInput`) and match it exactly rather than inventing a new one.

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @rg/server test -- jsonld.test.ts -t "showCallNumbers"`
Expected: FAIL on the first test — `telephone` is still present because `travelAgencyNode` doesn't check the flag yet.

- [ ] **Step 3: Gate `telephone`**

In `server/src/seo/jsonld.ts`, change line 169:

```ts
    telephone: input.contact.showCallNumbers ? text(input.contact.phoneTel) : undefined,
```

(`compact()`, already called on the returned object, drops any key whose value is `undefined` — no other change needed.)

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @rg/server test -- jsonld.test.ts -t "showCallNumbers"`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add server/src/seo/jsonld.ts server/src/__tests__/jsonld.test.ts
git commit -m "fix(server): omit JSON-LD telephone when call numbers are hidden"
```

---

### Task 4: Admin UI — a real switch, saved with the Contact section

This task has two parts: (a) a `toFormRow` bug the advisor's review caught — a legacy stored `contact` row with no `showCallNumbers` key would, on next Save, silently write `false` (the BUG-118 shape: a successful-looking save that changes real configuration) — and (b) the actual switch field.

**Files:**
- Modify: `client/src/components/admin/settings-blocks.ts` (`FieldSpec` interface ~line 48; `toFormRow` ~line 585; the `contact` block's `fields` array ~line 276-296)
- Modify: `client/src/pages/admin/AdminSettingsPage.tsx` (`FieldKind` import usage; `SettingField`'s render branches, ~line 131-225)
- Test: `client/src/__tests__/admin-settings-page.test.tsx`

**Interfaces:**
- Consumes: `FieldSpec` (existing type), `YES_NO` (existing exported constant, reference-compared).
- Produces: `FieldKind` gains `'switch'`. `FieldSpec` gains optional `defaultValue?: string`. `toFormRow` honours `defaultValue` when a path is `undefined` (key missing from the stored row) — not when it is `null`.

- [ ] **Step 1: Write the failing tests**

In `client/src/__tests__/admin-settings-page.test.tsx`, find the local raw-blocks fixture (the one Task 1 added `showCallNumbers: true` to, ~line 125-138) and the `openBlock` helper. Add two tests:

```ts
describe('Contact details — showCallNumbers switch (owner decision 2026-11-27)', () => {
  it('shows a labeled switch with the owner-specified helper text', async () => {
    mockTrpc({ 'admin.settings.all': CONTACT_FIXTURE_BLOCKS }); // match the file's existing mock-setup call
    renderPage();
    const block = await openBlock('Contact details');
    expect(within(block).getByText('Show phone numbers for calls/SMS')).toBeInTheDocument();
    expect(
      within(block).getByText(
        'Off = guests only see WhatsApp and Viber. The numbers still power those buttons.',
      ),
    ).toBeInTheDocument();
    const toggle = within(block).getByRole('switch', { name: /show phone numbers/i });
    expect(toggle).toHaveAttribute('aria-checked', 'true');
  });

  it('a legacy row with no showCallNumbers key still saves true, not false (BUG-118 shape)', async () => {
    const legacyRow = { ...CONTACT_FIXTURE_BLOCKS }; // whatever the file's mock-setup shape actually is
    delete (legacyRow.contact as Record<string, unknown>).showCallNumbers;
    mockTrpc({ 'admin.settings.all': legacyRow });
    const write = vi.fn();
    mockTrpcMutation('admin.settings.write', write); // match the file's existing mutation-mock helper
    renderPage();
    const block = await openBlock('Contact details');
    await userEvent.click(within(block).getByRole('button', { name: /save/i }));
    expect(write).toHaveBeenCalledWith(
      expect.objectContaining({
        key: 'contact',
        value: expect.objectContaining({ showCallNumbers: true }),
      }),
    );
  });
});
```

Adjust the exact mock/render helper names to whatever `admin-settings-page.test.tsx` already uses elsewhere in the file (it already has patterns for opening a block, mocking `admin.settings.all`, and asserting on a `write.mutate` call for other blocks — copy one of those, e.g. the `permits`/`show_tours` test, rather than guessing new helper names).

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @rg/client test -- admin-settings-page.test.tsx -t "showCallNumbers switch"`
Expected: FAIL — no field with that label exists yet, and (once it does, temporarily, via Step 3) the legacy-row test fails because `toFormRow` returns `''` for the missing key and `fromFormRow` turns that into `false`.

- [ ] **Step 3: Fix `toFormRow` to honour a per-field default for a MISSING key**

In `client/src/components/admin/settings-blocks.ts`, add to `FieldSpec` (~line 48-58):

```ts
export interface FieldSpec {
  name: string;
  label: string;
  kind: FieldKind;
  nullable?: boolean;
  options?: readonly { value: string; label: string }[];
  hint?: string;
  rows?: number;
  /**
   * What `toFormRow` shows when this field's path is MISSING from the
   * stored record (`undefined`, never `null`) — e.g. `'true'` for a
   * boolean added after rows already existed, so a legacy row's next Save
   * does not silently flip it to the opposite of its documented default
   * (owner decision 2026-11-27; this is the BUG-118 shape: a successful
   * save that changes real configuration). Leave unset for every field
   * whose correct missing-value behaviour is genuinely blank.
   */
  defaultValue?: string;
}
```

Change `toFormRow` (~line 585-596):

```ts
export function toFormRow(record: unknown, fields: readonly FieldSpec[]): Record<string, string> {
  const row: Record<string, string> = {};
  for (const field of fields) {
    const raw = readPath(record, field.name);
    if (raw === undefined) {
      row[field.name] = field.defaultValue ?? '';
      continue;
    }
    if (field.kind === 'manilaDatetime') {
      row[field.name] = typeof raw === 'string' ? utcIsoToManilaLocal(raw) : '';
      continue;
    }
    row[field.name] = raw === null ? '' : String(raw);
  }
  return row;
}
```

(This only changes behaviour for a field that sets `defaultValue` — every existing field has no `defaultValue`, so `field.defaultValue ?? ''` is `''`, identical to today's `raw === null || raw === undefined ? '' : ...` for the `undefined` branch. The `null` branch is now handled by the final line, unchanged from before.)

- [ ] **Step 4: Add the `switch` FieldKind and render it**

In `client/src/components/admin/settings-blocks.ts`, extend `FieldKind` (~line 27-46):

```ts
export type FieldKind =
  | 'text'
  | 'textarea'
  | 'number'
  | 'select'
  /** A boolean, drawn as the same labeled toggle used elsewhere on this screen — not a <select>. */
  | 'switch'
  | 'time'
  | 'manilaDatetime'
  | 'stamp'
  | 'rowIndex'
  | 'hidden';
```

Add the field to the `contact` block's `fields` array (~line 276-296), right after `hoursNote` so it reads naturally near the other contact-method fields:

```ts
      { name: 'hoursNote', label: 'Hours note', kind: 'text' },
      {
        name: 'showCallNumbers',
        label: 'Show phone numbers for calls/SMS',
        kind: 'switch',
        options: YES_NO,
        defaultValue: 'true',
        hint: 'Off = guests only see WhatsApp and Viber. The numbers still power those buttons.',
      },
      { name: 'email', label: 'Email', kind: 'text' },
```

In `client/src/pages/admin/AdminSettingsPage.tsx`, add a new branch to `SettingField` (~line 163, right before the existing `field.kind === 'select'` branch or after it — either position is fine, they're mutually exclusive):

```tsx
      ) : field.kind === 'switch' ? (
        /*
         * The same hand-rolled role="switch" markup as `ToggleBlockEditor`
         * and the per-item accreditation "Show" switch — reused a third
         * time rather than abstracted, matching how this file already
         * duplicates it once (owner decision 2026-11-27). `value`/`onChange`
         * still carry 'true'/'false' strings, exactly like a YES_NO select —
         * `fromFormRow`'s `field.options === YES_NO` check (this field sets
         * `options: YES_NO`) is what converts that string to a real boolean
         * on Save, unchanged from how every other boolean-in-an-object-block
         * field already works.
         */
        <div className="flex items-center gap-3">
          <button
            id={inputId}
            type="button"
            role="switch"
            aria-checked={value === 'true'}
            aria-describedby={describedBy}
            onClick={() => onChange(value === 'true' ? 'false' : 'true')}
            className="tap-target focus-visible:ring-brand-blue-600 inline-flex items-center justify-center rounded-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2"
          >
            <span
              aria-hidden="true"
              className={cn(
                'relative inline-flex h-7 w-12 shrink-0 items-center rounded-full transition-colors',
                value === 'true' ? 'bg-brand-blue-600' : 'bg-slate-300',
              )}
            >
              <span
                className={cn(
                  'inline-block size-5 rounded-full bg-white shadow transition-transform',
                  value === 'true' ? 'translate-x-6' : 'translate-x-1',
                )}
              />
            </span>
          </button>
          <span className="text-brand-ink text-sm font-medium">
            {value === 'true' ? 'On' : 'Off'}
          </span>
        </div>
      ) : field.kind === 'select' ? (
```

(`cn` is already imported in this file — `ToggleBlockEditor` uses it a few hundred lines down.) Confirm the existing `select` branch's opening `) : field.kind === 'select' ? (` is adjusted to chain correctly — read the surrounding 20 lines before editing so the ternary chain stays syntactically valid.

- [ ] **Step 5: Run tests to verify they pass**

Run: `pnpm --filter @rg/client test -- admin-settings-page.test.tsx -t "showCallNumbers"`
Expected: PASS, both tests.

- [ ] **Step 6: Run the full admin-settings-page suite** (this file has broad coverage of every block; a `FieldKind` change is exactly the kind of edit that could silently break an unrelated block)

Run: `pnpm --filter @rg/client test -- admin-settings-page.test.tsx`
Expected: PASS, all tests.

- [ ] **Step 7: Commit**

```bash
git add client/src/components/admin/settings-blocks.ts client/src/pages/admin/AdminSettingsPage.tsx client/src/__tests__/admin-settings-page.test.tsx
git commit -m "feat(client): admin switch for Show phone numbers for calls/SMS"
```

---

### Task 5: Shared client hook + SiteHeader

**Files:**
- Create: `client/src/lib/contact-visibility.ts`
- Modify: `client/src/components/layout/SiteHeader.tsx`
- Test: `client/src/__tests__/layout.test.tsx`

**Interfaces:**
- Produces: `useShowCallNumbers(): boolean` — `true` until `settings.get` resolves (so the happy path, where the switch stays on, never flickers), `false` only once the server has explicitly said so. Every task from here on imports this one hook rather than re-deriving the expression.

- [ ] **Step 1: Create the shared hook**

```ts
// client/src/lib/contact-visibility.ts
import { trpc } from '@/lib/trpc';

/**
 * Whether the public site may show "call or text this number" surfaces
 * (owner decision 2026-11-27 — the owner works at sea and cannot take
 * calls/SMS; WhatsApp, Viber, email and Facebook are unaffected and read
 * their own numbers from `@/lib/site`, not from this).
 *
 * Defaults to `true` (numbers shown) until `settings.get` resolves, matching
 * the product default and SiteFooter's own `=== true` precedent for a
 * boolean that should not flash the "hidden" state on the happy path while
 * loading. The one case this costs something is the rare admin who has
 * switched it off: a page load briefly renders the phone number before the
 * query lands. That is the accepted tradeoff — the alternative flashes a
 * number an admin is actively trying not to publish, on every single page
 * load, for every guest, whether the switch is on or off.
 */
export function useShowCallNumbers(): boolean {
  const { data: settings } = trpc.settings.get.useQuery();
  return settings?.contact.showCallNumbers ?? true;
}
```

- [ ] **Step 2: Write the failing test**

In `client/src/__tests__/layout.test.tsx`, add a new `describe` block (model its render helper on the existing ones in this file, e.g. the `SiteFooter` WhatsApp/Viber describe block at line ~545):

```tsx
describe('SiteHeader — call number hidden (owner decision 2026-11-27)', () => {
  it('shows the tel link when showCallNumbers is true', () => {
    mockTrpc({
      'settings.get': settingsWith({ contact: { ...SETTINGS_FIXTURE.contact, showCallNumbers: true } }),
    });
    render(
      <TrpcProviders>
        <MemoryRouter>
          <SiteHeader />
        </MemoryRouter>
      </TrpcProviders>,
    );
    expect(screen.getByRole('link', { name: SITE.contact.phone.display })).toHaveAttribute(
      'href',
      `tel:${SITE.contact.phone.tel}`,
    );
  });

  it('replaces the tel link with a WhatsApp action when showCallNumbers is false', () => {
    mockTrpc({
      'settings.get': settingsWith({
        contact: { ...SETTINGS_FIXTURE.contact, showCallNumbers: false },
      }),
    });
    render(
      <TrpcProviders>
        <MemoryRouter>
          <SiteHeader />
        </MemoryRouter>
      </TrpcProviders>,
    );
    expect(screen.queryByText(SITE.contact.phone.display)).not.toBeInTheDocument();
    expect(document.querySelector(`a[href^="tel:"]`)).toBeNull();
    const chat = screen.getByRole('link', { name: 'Chat on WhatsApp' });
    expect(chat).toHaveAttribute('href', expect.stringContaining('wa.me'));
    expect(screen.getByText('WhatsApp')).toBeInTheDocument();
  });
});
```

Match this file's actual import list and `settingsWith`/fixture helper names — `layout.test.tsx` already has its own `mockTrpc`/fixture setup (check its top ~20 lines for the exact names before pasting; do not assume `settingsWith` exists there exactly as in `contact-footer.test.tsx` — copy whichever pattern that specific file already uses, or import `SETTINGS_FIXTURE` directly and spread it inline if the file has no such helper yet).

- [ ] **Step 3: Run test to verify it fails**

Run: `pnpm --filter @rg/client test -- layout.test.tsx -t "call number hidden"`
Expected: FAIL — both tests, since `SiteHeader` doesn't read `showCallNumbers` at all yet (the first test fails only if the fixture's default isn't already true — if it passes, that's fine, the point is the second test must fail).

- [ ] **Step 4: Implement the gate in SiteHeader**

In `client/src/components/layout/SiteHeader.tsx`:

Change the import line (currently `import { SITE, telLink, visibleNav } from '@/lib/site';`):

```tsx
import { SITE, telLink, visibleNav, whatsappLink } from '@/lib/site';
```

Add near the top of the component, alongside the existing `settings` query (there already is one, for `showTours`):

```tsx
import { WhatsAppGlyph } from '@/components/common/BrandGlyphs';
import { useShowCallNumbers } from '@/lib/contact-visibility';
```

Inside `SiteHeader()`, after the existing `const { data: settings } = trpc.settings.get.useQuery();` line:

```tsx
  const showCallNumbers = useShowCallNumbers();
```

Replace the desktop phone link (currently):

```tsx
          <a
            href={telLink(SITE.contact.phone.tel)}
            className="text-brand-blue-700 tap-target hidden items-center gap-2 rounded-md px-3 text-sm font-semibold lg:flex"
          >
            <Phone className="size-4" aria-hidden="true" />
            {SITE.contact.phone.display}
          </a>
```

with:

```tsx
          {showCallNumbers ? (
            <a
              href={telLink(SITE.contact.phone.tel)}
              className="text-brand-blue-700 tap-target hidden items-center gap-2 rounded-md px-3 text-sm font-semibold lg:flex"
            >
              <Phone className="size-4" aria-hidden="true" />
              {SITE.contact.phone.display}
            </a>
          ) : (
            <a
              href={whatsappLink()}
              target="_blank"
              rel="noreferrer noopener"
              aria-label="Chat on WhatsApp"
              className="tap-target hidden items-center gap-2 lg:flex"
            >
              <span className="press-brand bg-whatsapp hover:bg-whatsapp-pressed flex size-11 shrink-0 items-center justify-center rounded-full text-white transition-[transform,box-shadow,background-color] duration-200 hover:-translate-y-0.5 hover:shadow-md">
                <WhatsAppGlyph className="size-5" />
              </span>
              <span aria-hidden="true" className="text-brand-blue-700 text-sm font-semibold">
                WhatsApp
              </span>
            </a>
          )}
```

(This mirrors `SiteFooter.tsx`'s existing `ChatButton` accessibility pattern exactly: the pill is icon-only with its own `aria-label`, the visible "WhatsApp" word sits outside it in brand ink and is `aria-hidden` so the link's name isn't announced twice.)

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm --filter @rg/client test -- layout.test.tsx -t "call number hidden"`
Expected: PASS

- [ ] **Step 6: Run the full layout suite** (this file pins several unrelated nav/FloatingWhatsApp behaviours)

Run: `pnpm --filter @rg/client test -- layout.test.tsx`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add client/src/lib/contact-visibility.ts client/src/components/layout/SiteHeader.tsx client/src/__tests__/layout.test.tsx
git commit -m "feat(client): header shows WhatsApp instead of a tel link when call numbers are hidden"
```

---

### Task 6: SiteFooter

**Files:**
- Modify: `client/src/components/layout/SiteFooter.tsx`
- Test: `client/src/__tests__/contact-footer.test.tsx`

**Interfaces:**
- Consumes: `useShowCallNumbers()` from Task 5.

- [ ] **Step 1: Write the failing test**

In `client/src/__tests__/contact-footer.test.tsx`, add:

```tsx
describe('SiteFooter — call numbers hidden (owner decision 2026-11-27)', () => {
  it('keeps the Smart/Globe numbers when showCallNumbers is true', async () => {
    mockTrpc({
      'settings.get': settingsWith({ contact: { ...SETTINGS_FIXTURE.contact, showCallNumbers: true } }),
    });
    renderWithTrpc(<SiteFooter />);
    expect(await screen.findByText(SITE.contact.phone.display)).toBeInTheDocument();
    expect(screen.getByText(SITE.contact.altPhone.display)).toBeInTheDocument();
    expect(screen.getByText('Smart')).toBeInTheDocument();
    expect(screen.getByText('Globe')).toBeInTheDocument();
  });

  it('removes both numbers and the network labels, keeps WhatsApp/Viber/email/Facebook, when false', async () => {
    mockTrpc({
      'settings.get': settingsWith({
        contact: { ...SETTINGS_FIXTURE.contact, showCallNumbers: false },
      }),
    });
    renderWithTrpc(<SiteFooter />);
    await screen.findByRole('link', { name: 'Chat on WhatsApp' });

    expect(screen.queryByText(SITE.contact.phone.display)).not.toBeInTheDocument();
    expect(screen.queryByText(SITE.contact.altPhone.display)).not.toBeInTheDocument();
    expect(screen.queryByText('Smart')).not.toBeInTheDocument();
    expect(screen.queryByText('Globe')).not.toBeInTheDocument();
    expect(document.querySelector('a[href^="tel:"]')).toBeNull();

    expect(screen.getByRole('link', { name: 'Chat on WhatsApp' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Chat on Viber' })).toBeInTheDocument();
    expect(screen.getByText(SITE.contact.email)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Facebook' })).toBeInTheDocument();
    expect(screen.getByText('Message us on WhatsApp or Viber')).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @rg/client test -- contact-footer.test.tsx -t "call numbers hidden"`
Expected: FAIL on the second test.

- [ ] **Step 3: Implement the gate**

In `client/src/components/layout/SiteFooter.tsx`, add the import:

```tsx
import { useShowCallNumbers } from '@/lib/contact-visibility';
```

Inside `SiteFooter()`, alongside the other derived values:

```tsx
  const showCallNumbers = useShowCallNumbers();
```

Replace the "Primary line" `<li>` (currently the Phone-icon + `telLink(SITE.contact.phone.tel)` + "Smart" block, right after the opening `<ul className="mt-6 space-y-2 text-base sm:text-sm">`) and the "Alternate line" `<li>` together. Current code (both `<li>`s, unabridged):

```tsx
            <li className="flex items-center gap-2">
              <Phone className="size-4 shrink-0" aria-hidden="true" />
              <a
                href={telLink(SITE.contact.phone.tel)}
                className="flex min-h-11 items-center gap-2 hover:underline"
              >
                {SITE.contact.phone.display}
                <span className="text-brand-blue-300 text-xs">{SITE.contact.phone.network}</span>
              </a>
            </li>
            <li className="flex items-start gap-2">
              <Phone className="mt-3.5 size-4 shrink-0" aria-hidden="true" />
              <div>
                <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
                  <a
                    href={telLink(SITE.contact.altPhone.tel)}
                    className="flex min-h-11 items-center gap-2 hover:underline"
                  >
                    {SITE.contact.altPhone.display}
                    <span className="text-brand-blue-300 text-xs">
                      {SITE.contact.altPhone.network}
                    </span>
                  </a>
                  <span className="flex items-center gap-2">
                    <ChatButton
                      tone="whatsapp"
                      href={whatsappLink()}
                      label="Chat on WhatsApp"
                      external
                    >
                      <WhatsAppGlyph className="size-5" />
                    </ChatButton>
                    <ChatButton tone="viber" href={viberLink()} label="Chat on Viber">
                      <ViberGlyph className="size-5" />
                    </ChatButton>
                  </span>
                </div>
                <p className="text-brand-blue-300 mt-1 text-xs">WhatsApp, Viber, calls and SMS</p>
              </div>
            </li>
```

Replace with:

```tsx
            {showCallNumbers && (
              <li className="flex items-center gap-2">
                <Phone className="size-4 shrink-0" aria-hidden="true" />
                <a
                  href={telLink(SITE.contact.phone.tel)}
                  className="flex min-h-11 items-center gap-2 hover:underline"
                >
                  {SITE.contact.phone.display}
                  <span className="text-brand-blue-300 text-xs">{SITE.contact.phone.network}</span>
                </a>
              </li>
            )}
            <li className="flex items-start gap-2">
              <Phone className="mt-3.5 size-4 shrink-0" aria-hidden="true" />
              <div>
                <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
                  {showCallNumbers && (
                    <a
                      href={telLink(SITE.contact.altPhone.tel)}
                      className="flex min-h-11 items-center gap-2 hover:underline"
                    >
                      {SITE.contact.altPhone.display}
                      <span className="text-brand-blue-300 text-xs">
                        {SITE.contact.altPhone.network}
                      </span>
                    </a>
                  )}
                  <span className="flex items-center gap-2">
                    <ChatButton
                      tone="whatsapp"
                      href={whatsappLink()}
                      label="Chat on WhatsApp"
                      external
                    >
                      <WhatsAppGlyph className="size-5" />
                    </ChatButton>
                    <ChatButton tone="viber" href={viberLink()} label="Chat on Viber">
                      <ViberGlyph className="size-5" />
                    </ChatButton>
                  </span>
                </div>
                <p className="text-brand-blue-300 mt-1 text-xs">
                  {showCallNumbers ? 'WhatsApp, Viber, calls and SMS' : 'Message us on WhatsApp or Viber'}
                </p>
              </div>
            </li>
```

(Keeping the alternate `<li>` mounted in both states — only its inner tel `<a>` and caption text change — avoids reflowing the WhatsApp/Viber buttons into a differently-shaped row.)

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @rg/client test -- contact-footer.test.tsx -t "call numbers hidden"`
Expected: PASS

- [ ] **Step 5: Run the full footer/contact test file**

Run: `pnpm --filter @rg/client test -- contact-footer.test.tsx`
Expected: PASS (this file also covers `FaqSection`/`FloatingWhatsApp`/open-closed state — confirm nothing else regressed).

- [ ] **Step 6: Commit**

```bash
git add client/src/components/layout/SiteFooter.tsx client/src/__tests__/contact-footer.test.tsx
git commit -m "feat(client): footer drops Call or text numbers when showCallNumbers is off"
```

---

### Task 7: ContactSection

**Files:**
- Modify: `client/src/components/home/ContactSection.tsx`
- Test: `client/src/__tests__/contact-footer.test.tsx` (this is where the existing `ContactSection` tests already live, per Task 6's research — confirm, and if `ContactSection` is actually covered in `home.test.tsx` instead, add there)

**Interfaces:**
- Consumes: `useShowCallNumbers()` from Task 5.

- [ ] **Step 1: Write the failing test**

```tsx
describe('ContactSection — call numbers hidden (owner decision 2026-11-27)', () => {
  it('keeps both Call or text rows when showCallNumbers is true', async () => {
    mockTrpc({
      'settings.get': settingsWith({ contact: { ...SETTINGS_FIXTURE.contact, showCallNumbers: true } }),
    });
    renderWithTrpc(<ContactSection />);
    expect(await screen.findByText(/Call or text \(Smart\)/)).toBeInTheDocument();
    expect(screen.getByText(/Call or text \(Globe\)/)).toBeInTheDocument();
  });

  it('removes both Call or text rows and adds the WhatsApp/Viber line when false', async () => {
    mockTrpc({
      'settings.get': settingsWith({
        contact: { ...SETTINGS_FIXTURE.contact, showCallNumbers: false },
      }),
    });
    renderWithTrpc(<ContactSection />);
    await screen.findByText('Message us on WhatsApp or Viber.');

    expect(screen.queryByText(/Call or text/)).not.toBeInTheDocument();
    expect(document.querySelector('a[href^="tel:"]')).toBeNull();
    expect(screen.getByText('WhatsApp')).toBeInTheDocument();
    expect(screen.getByText('Viber')).toBeInTheDocument();
    expect(screen.getByText('Email')).toBeInTheDocument();
    expect(screen.getByText('Facebook')).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @rg/client test -- -t "ContactSection — call numbers hidden"` (add the correct test-file filename once confirmed in Step 1)
Expected: FAIL on the second test.

- [ ] **Step 3: Implement the gate**

Add the import and hook call to `ContactSection.tsx`, same pattern as Tasks 5-6:

```tsx
import { useShowCallNumbers } from '@/lib/contact-visibility';
```

```tsx
  const showCallNumbers = useShowCallNumbers();
```

Wrap the two "Call or text" `<li>` items (currently the two unconditional `<li>` blocks right after `<ul className="space-y-4">`, each containing a `telLink(...)` anchor) in `{showCallNumbers && (...)}`:

```tsx
            {showCallNumbers && (
              <li>
                <a
                  href={telLink(SITE.contact.phone.tel)}
                  className="bg-background hover:bg-brand-blue-100 flex min-h-11 items-center gap-3 rounded-xl p-4 text-base sm:text-sm"
                >
                  <Phone className="text-brand-blue-600 size-5 shrink-0" aria-hidden="true" />
                  <span>
                    <span className="text-brand-blue-900 block font-semibold">
                      Call or text ({SITE.contact.phone.network})
                    </span>
                    <span className="text-muted-foreground">{SITE.contact.phone.display}</span>
                  </span>
                </a>
              </li>
            )}
            {showCallNumbers && (
              <li>
                <a
                  href={telLink(SITE.contact.altPhone.tel)}
                  className="bg-background hover:bg-brand-blue-100 flex min-h-11 items-center gap-3 rounded-xl p-4 text-base sm:text-sm"
                >
                  <Phone className="text-brand-blue-600 size-5 shrink-0" aria-hidden="true" />
                  <span>
                    <span className="text-brand-blue-900 block font-semibold">
                      Call or text ({SITE.contact.altPhone.network})
                    </span>
                    <span className="text-muted-foreground">{SITE.contact.altPhone.display}</span>
                  </span>
                </a>
              </li>
            )}
            {!showCallNumbers && (
              <li className="bg-background flex items-center gap-3 rounded-xl p-4 text-base sm:text-sm">
                <p className="text-brand-blue-900 font-semibold">Message us on WhatsApp or Viber.</p>
              </li>
            )}
```

(The WhatsApp/Viber/Email/Facebook/Office/Hours `<li>`s below are untouched — leave them exactly as they are.)

- [ ] **Step 4: Run test to verify it passes**

Run the same command as Step 2.
Expected: PASS

- [ ] **Step 5: Run the full file this lives in**

Run: `pnpm --filter @rg/client test -- contact-footer.test.tsx` (or `home.test.tsx`, whichever Step 1 confirmed)
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add client/src/components/home/ContactSection.tsx
git commit -m "feat(client): contact section drops Call or text rows when showCallNumbers is off"
```

---

### Task 8: PaymentOptions — checkout's "we'll take your payment directly" fallback

**Found during research, not in the original file list — the task's own "find all" instruction covers it.** `ContactToPay` in `PaymentOptions.tsx` renders "Message us on WhatsApp · {phone number}" on the public checkout/booking-status retry page whenever online payment is unavailable. This is a public call-number surface the original brief didn't name but clearly falls under "no 'call/text us' numbers shown."

**Files:**
- Modify: `client/src/components/checkout/PaymentOptions.tsx:97-130` (`ContactToPay`)
- Test: `client/src/__tests__/payment-options.test.tsx`

**Interfaces:**
- Consumes: `useShowCallNumbers()` from Task 5.

- [ ] **Step 1: Write the failing test**

In `client/src/__tests__/payment-options.test.tsx`, find how it already renders the "manual only" / "neither configured" state (whatever triggers `ContactToPay` — check the component for the exact prop/settings combination that selects state 3 before writing this). Add:

```tsx
describe('ContactToPay — call number hidden (owner decision 2026-11-27)', () => {
  it('keeps the phone number when showCallNumbers is true', () => {
    // render in whatever state this file already uses to reach ContactToPay,
    // with contact.showCallNumbers: true
    expect(screen.getByText(SITE.contact.phone.display)).toBeInTheDocument();
  });

  it('removes the phone number and keeps the WhatsApp link when false', () => {
    // same state, with contact.showCallNumbers: false
    expect(screen.queryByText(SITE.contact.phone.display)).not.toBeInTheDocument();
    expect(document.querySelector('a[href^="tel:"]')).toBeNull();
    expect(screen.getByText('Message us on WhatsApp')).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @rg/client test -- payment-options.test.tsx -t "call number hidden"`
Expected: FAIL on the second test.

- [ ] **Step 3: Implement the gate**

In `client/src/components/checkout/PaymentOptions.tsx`, add the import:

```tsx
import { useShowCallNumbers } from '@/lib/contact-visibility';
```

Change `ContactToPay`:

```tsx
function ContactToPay({ bookingRef }: { bookingRef: string }) {
  const message = `Hi ${SITE.name}! I'd like to pay for booking ${bookingRef}.`;
  const showCallNumbers = useShowCallNumbers();
  return (
    <div
      role="status"
      className="border-brand-blue-200 bg-brand-blue-50 text-brand-blue-900 space-y-2 rounded-xl border p-4"
    >
      <p className="text-sm font-semibold">We'll take your payment directly</p>
      <p className="text-sm">
        Online payment isn't available right now, but your spot is held. Message us with your
        booking reference and we'll sort it out with you.
      </p>
      <p className="text-sm">
        <a
          href={whatsappLink(message)}
          target="_blank"
          rel="noreferrer noopener"
          className="text-brand-blue-700 hover:text-brand-blue-900 tap-target inline-flex items-center font-semibold underline underline-offset-2"
        >
          Message us on WhatsApp
        </a>
        {showCallNumbers && (
          <>
            <span className="px-2" aria-hidden="true">
              ·
            </span>
            <a
              href={telLink(SITE.contact.phone.tel)}
              className="text-brand-blue-700 hover:text-brand-blue-900 tap-target inline-flex items-center font-semibold underline underline-offset-2"
            >
              {SITE.contact.phone.display}
            </a>
          </>
        )}
      </p>
    </div>
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @rg/client test -- payment-options.test.tsx -t "call number hidden"`
Expected: PASS

- [ ] **Step 5: Run the full file**

Run: `pnpm --filter @rg/client test -- payment-options.test.tsx`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add client/src/components/checkout/PaymentOptions.tsx client/src/__tests__/payment-options.test.tsx
git commit -m "feat(client): checkout's direct-payment fallback drops the phone number when showCallNumbers is off"
```

---

### Task 9: Legal pages — `terms.tsx` / `privacy.tsx` / `refundPolicy.tsx`

These three files build their JSX at **module scope** (`export const termsContent: LegalPageContent = {...}`), so no hook can run inline inside them. The fix is a small shared component in `client/src/content/legal/shared.tsx` (already the home of `PlaceholderChip`/`ScrollableTable`) that calls the settings query itself and is dropped into all five existing `tel:` spots.

**Files:**
- Modify: `client/src/content/legal/shared.tsx` (add `ContactLine`)
- Modify: `client/src/content/legal/terms.tsx` (1 spot, line ~197)
- Modify: `client/src/content/legal/privacy.tsx` (2 spots, lines ~200 and ~237)
- Modify: `client/src/content/legal/refundPolicy.tsx` (2 spots, lines ~25 and ~150)
- Test: `client/src/__tests__/legal-pages.test.tsx`

**Interfaces:**
- Produces: `ContactLine` — a React component (not a plain function returning JSX at module scope) that renders `<a href="tel:...">` when call numbers are shown, or a WhatsApp + Viber pair joined by " or " when they are not.
- Consumes: `useShowCallNumbers()` from Task 5, `whatsappLink`/`viberLink`/`SITE` from `@/lib/site`.

- [ ] **Step 1: Write the failing test**

In `client/src/__tests__/legal-pages.test.tsx`, check how it currently renders `/terms`, `/privacy`, `/refund-policy` (it likely already wraps them in `TrpcProviders`/`MemoryRouter` given the existing SEO/placeholder tests in that file — read its top ~40 lines before writing this, and reuse its exact render helper). Add:

```tsx
describe('legal pages — contact line follows showCallNumbers (owner decision 2026-11-27)', () => {
  it('Terms shows the tel link when true', async () => {
    mockTrpc({
      'settings.get': settingsWith({ contact: { ...SETTINGS_FIXTURE.contact, showCallNumbers: true } }),
    });
    renderLegalPage('/terms'); // match this file's actual render helper name
    expect(await screen.findByText(SITE.contact.phone.display)).toBeInTheDocument();
  });

  it('Terms, Privacy and Refund Policy all drop the tel link and show WhatsApp/Viber when false', async () => {
    mockTrpc({
      'settings.get': settingsWith({
        contact: { ...SETTINGS_FIXTURE.contact, showCallNumbers: false },
      }),
    });
    for (const path of ['/terms', '/privacy', '/refund-policy']) {
      const { unmount } = renderLegalPage(path);
      await screen.findByText('WhatsApp');
      expect(document.querySelector('a[href^="tel:"]')).toBeNull();
      expect(screen.getByText('Viber')).toBeInTheDocument();
      unmount();
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @rg/client test -- legal-pages.test.tsx -t "contact line follows showCallNumbers"`
Expected: FAIL on the second test.

- [ ] **Step 3: Add `ContactLine` to `shared.tsx`**

```tsx
// client/src/content/legal/shared.tsx — add near the top, after the existing import
import { useShowCallNumbers } from '@/lib/contact-visibility';
import { SITE, viberLink, whatsappLink } from '@/lib/site';

// ...after PlaceholderChip, before the LegalSection/LegalPageContent types...

/**
 * The phone contact for a legal page's "Contact us" line (owner decision
 * 2026-11-27). `terms.tsx`/`privacy.tsx`/`refundPolicy.tsx` build their
 * content as plain objects at MODULE scope, so none of them can call a hook
 * directly — this is a real component instead, dropped into each spot as
 * `<ContactLine />`, so the hook runs at actual render time inside whatever
 * tree eventually mounts it.
 */
export function ContactLine() {
  const showCallNumbers = useShowCallNumbers();
  if (showCallNumbers) {
    return <a href={`tel:${SITE.contact.phone.tel}`}>{SITE.contact.phone.display}</a>;
  }
  return (
    <>
      <a href={whatsappLink()} target="_blank" rel="noreferrer noopener">
        WhatsApp
      </a>
      {' or '}
      <a href={viberLink()}>Viber</a>
    </>
  );
}
```

- [ ] **Step 4: Swap all five occurrences**

In `terms.tsx`, `privacy.tsx`, `refundPolicy.tsx`, update the import line from:

```tsx
import { PlaceholderChip, type LegalPageContent } from './shared';
```

to:

```tsx
import { ContactLine, PlaceholderChip, type LegalPageContent } from './shared';
```

(`refundPolicy.tsx` additionally imports `ScrollableTable` — keep that.)

Then replace each `<a href={`tel:${SITE.contact.phone.tel}`}>{SITE.contact.phone.display}</a>` with `<ContactLine />`:

`terms.tsx` (~line 197):
```tsx
          <a href={`mailto:${SITE.contact.email}`}>{SITE.contact.email}</a> ·{' '}
          <ContactLine />
```

`privacy.tsx` (~line 200, the DPO line):
```tsx
            <a href={`mailto:${SITE.contact.email}`}>{SITE.contact.email}</a> ·{' '}
            <ContactLine />
```

`privacy.tsx` (~line 237, the "9. Contact" footer):
```tsx
          <a href={`mailto:${SITE.contact.email}`}>{SITE.contact.email}</a> ·{' '}
          <ContactLine />
```

`refundPolicy.tsx` (~line 25, "Cancel by contacting us at..."):
```tsx
            Cancel by contacting us at{' '}
            <a href={`mailto:${SITE.contact.email}`}>{SITE.contact.email}</a> or <ContactLine /> with
            your booking reference. Cancellation time is counted from your tour's pickup time
            (Philippine time).
```

`refundPolicy.tsx` (~line 150, the matching second occurrence — check whether it's the same sentence duplicated in a different section and match its exact surrounding wording when editing, don't blindly copy the line above without reading the actual surrounding paragraph first).

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm --filter @rg/client test -- legal-pages.test.tsx -t "contact line follows showCallNumbers"`
Expected: PASS

- [ ] **Step 6: Run the full legal-pages suite**

Run: `pnpm --filter @rg/client test -- legal-pages.test.tsx`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add client/src/content/legal/shared.tsx client/src/content/legal/terms.tsx client/src/content/legal/privacy.tsx client/src/content/legal/refundPolicy.tsx client/src/__tests__/legal-pages.test.tsx
git commit -m "feat(client): legal pages show WhatsApp/Viber instead of a phone number when showCallNumbers is off"
```

---

### Task 10: FloatingWhatsApp — regression test only, no production code change

**Files:**
- Test: `client/src/__tests__/floating-whatsapp.test.tsx`

**Why no code change:** `FloatingWhatsApp.tsx` (desktop bubble and mobile bottom bar) already has no call/phone button in either state — it only ever renders "Book a transfer"/"Book a tour" plus the WhatsApp control. Confirmed by reading the full file: no `tel:` link, no `SITE.contact.phone` reference anywhere in it. The task brief's "Mobile bar / floating contact: no call button; Book + WhatsApp stay" requirement is already satisfied. Add a test that pins this so a future change can't reintroduce one — and prove the test can actually fail before trusting it.

- [ ] **Step 1: Write the test**

In `client/src/__tests__/floating-whatsapp.test.tsx`, add:

```tsx
describe('FloatingWhatsApp — never shows a call number, in either showCallNumbers state (owner decision 2026-11-27)', () => {
  it.each([true, false])('renders no tel: link when showCallNumbers is %s', async (showCallNumbers) => {
    mockTrpc({
      'settings.get': settingsWith({
        contact: { ...SETTINGS_FIXTURE.contact, showCallNumbers },
      }),
    });
    renderWithTrpc(<FloatingWhatsApp />); // match this file's actual render helper
    await screen.findByRole('link', { name: 'Chat with us on WhatsApp' });
    expect(document.querySelectorAll('a[href^="tel:"]')).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Prove the test can fail**

Temporarily add a throwaway line inside `FloatingWhatsApp.tsx`'s mobile bottom bar `<div>` (right before the `<Button asChild size="lg" ...>` "Book a tour/transfer" button):

```tsx
<a href="tel:+639999999999">temp</a>
```

Run: `pnpm --filter @rg/client test -- floating-whatsapp.test.tsx -t "never shows a call number"`
Expected: FAIL (confirms the test actually exercises the DOM, not a tautology).

Remove the throwaway line immediately after confirming the failure — do not leave it in.

- [ ] **Step 3: Run the real test to confirm it passes against the unmodified component**

Run: `pnpm --filter @rg/client test -- floating-whatsapp.test.tsx -t "never shows a call number"`
Expected: PASS

- [ ] **Step 4: Run the full file**

Run: `pnpm --filter @rg/client test -- floating-whatsapp.test.tsx`
Expected: PASS

- [ ] **Step 5: Spot-check 360px manually** (no automated viewport test exists in this suite for this component — this is a manual confirmation, not a new test)

Run the dev server (`pnpm dev`, client on port **5180** — never 5173/3000) and resize the browser to 360px width on `/`, with the admin switch both on and off (toggle it via `/admin/settings` → Contact details → Save, in a second tab), confirming: the mobile bottom bar shows Book + WhatsApp only in both states, the header's desktop phone/WhatsApp swap doesn't appear at 360px (it's `lg:flex`, hidden on mobile already — the mobile nav never had a phone row), and the footer/ContactSection WhatsApp/Viber buttons remain 44px tap targets with no horizontal scroll.

- [ ] **Step 6: Commit**

```bash
git add client/src/__tests__/floating-whatsapp.test.tsx
git commit -m "test(client): pin that FloatingWhatsApp never shows a tel: link, in either showCallNumbers state"
```

---

### Task 11: Full verification and merge

**Files:** none (verification only)

- [ ] **Step 1: Run all five checks, in this exact order, solo (not alongside other work)**

```bash
pnpm lint
pnpm typecheck
pnpm test
pnpm format:check
ALLOW_PLACEHOLDER_BUILD=1 pnpm build
```

Fix anything that fails before proceeding — do not report any step done without having actually run it and read its output.

- [ ] **Step 2: Confirm every new test was proven able to fail**

Re-check Tasks 1-10's "verify it fails" steps all actually showed a red run before the fix landed (this should already be true from following the plan — this step is a final audit, not new work).

- [ ] **Step 3: Review `git log` for this branch/session and confirm commit messages match the "hash - short label" reporting format** the task brief asked for (that's for the final report, not the commit messages themselves, which should stay conventional — `feat(...)`/`fix(...)`/`test(...)` as written in each task above).

- [ ] **Step 4: Merge to main locally (fast-forward only, no push)**

```bash
git status
git log --oneline -15
```

Confirm there are no uncommitted changes and the branch is a clean, linear sequence of this plan's commits ahead of `main`. If working directly on `main`, there is nothing to merge — skip this step. If on a feature branch:

```bash
git checkout main
git merge --ff-only <branch-name>
```

Do **not** push. Do not force anything. If the merge is not a clean fast-forward, stop and report rather than forcing it.

---

### Task 12: Reviewer pass (separate sub-agent)

Dispatch a fresh reviewer (not the implementer) with the following checklist, derived from the task brief's own review criteria:

1. **No `tel:` link or static call number renders anywhere on the public site when `showCallNumbers` is false.** Run the app (or the test suite) with the setting off and grep the rendered HTML of `/`, `/terms`, `/privacy`, `/refund-policy`, and a checkout page in the "manual only"/"neither" state, for `tel:` and for the literal strings `0908`/`0927`/`639084696246`/`639277378431`. Also check the raw `settings.get` JSON response has no `phoneDisplay`/`phoneTel`/`altPhoneDisplay`/`altPhoneTel` keys, and that `/` 's JSON-LD has no `telephone` key.
2. **WhatsApp and Viber still work in both states** — `wa.me`/`viber:` links present and correctly numbered, unchanged from before this task.
3. **`client/src/pages/driver/DriverTripPage.tsx` and `client/src/components/portal/DriverCard.tsx` are byte-for-byte unchanged** (`git diff main -- these two files` should be empty) — their `tel:` links are the driver's/guest's own numbers, explicitly out of scope.
4. **CLAUDE.md brand-colour rule:** every WhatsApp/Viber pill touched or added by this plan is icon-only with `aria-label`; visible "WhatsApp"/"Viber" text sits outside the pill in brand ink, `aria-hidden`; no white text on `#25D366`; `#128C7E` only as the WhatsApp hover/pressed state. No red anywhere, including the new admin switch (blue-on, grey-off, matching the existing toggle pattern).
5. **44px tap targets** on the new header WhatsApp control and everywhere else touched.
6. **360px**: re-run the Task 10 Step 5 manual check if not already confirmed; no horizontal scroll introduced by the footer/ContactSection text changes.
7. **Every new test is provably able to fail** — spot-check at least 3 of the tests added across Tasks 1-10 by temporarily breaking the corresponding production code and confirming the test goes red, then restoring it.
8. **`scripts/check-contact-parity.mjs` / `coming-soon/index.html` are unchanged** — `git diff main -- coming-soon scripts/check-contact-parity.mjs` should be empty.
9. Re-run the five verification commands from Task 11 independently.

Fix anything found, then re-review once. Report remaining findings (if any) rather than looping indefinitely.

---

## Unrelated bugs noticed during research (log only, per CLAUDE.md — do not fix as part of this task)

- **`client/src/components/admin/settings-blocks.ts`'s `contact` block fields `phoneDisplay`/`phoneTel`/`altPhoneDisplay`/`altPhoneTel`/`whatsapp`/`email`/`facebook`/`motto` are editable in the admin Settings screen, but no public component reads `settings.contact.*` for those values — every public render uses the static `SITE.contact` object in `client/src/lib/site.ts` instead.** An owner who edits these fields and saves sees no effect anywhere on the live site. This plan does not fix that pre-existing disconnect (out of scope — the task only asked to hide numbers, not to make the admin-editable ones authoritative); it only adds one new boolean to the same block, gated independently in each component via the static `SITE` values, as every other field there already (silently) is.

## Final marker

Write **✅ HIDE CALL NUMBERS COMPLETE** only after Task 12's reviewer pass reports no remaining findings and Task 11's five commands have all been run and passed.
