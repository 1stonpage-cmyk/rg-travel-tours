# Flexible transfer places, routes, vehicle types — design note (0A)

**Owner decisions:** given directly, 2026-11-08 (see the batch prompt). Supersedes the
2026-10-31 transfers-launch plan's "one route per destination, airport ↔ destination" design
(Architecture §1) and the `van`/`suv` enum used throughout. Everything else in that plan
(availability windows §2/§2a, quote/hold flow §3, `show_tours` §4, roles §5, custom-trip
conversion §6) is **unchanged** — this note only replaces the vehicle-type/route/place layer
underneath it.

**Base commit:** `f241af9` on `main` (T1–T16 landed, Batch 4b; T17 not started). Migrations
owed: 0015–0022 (per HANDOVER-4), then this batch's new ones below.

**Scope of this note:** schema + migrations, the data migration for existing rows, what
changes in each service/procedure, and the test plan. Admin/public UI (1D/1E) and demo data
(1G) are described at the level this note needs to brief their implementers; the implementers
do their own file-level reconnaissance.

---

## 0. Migration mechanics (added after Opus review)

**Migrations 0023–0029 below are hand-written, not `db:generate` output.** `db:migrate` is
`drizzle-kit migrate`, which reads `server/src/db/migrations/meta/_journal.json` and a paired
`NNNN_snapshot.json` per migration. Running `db:generate` against the *already-edited*
`schema.ts` would diff straight from the OLD snapshot to the NEW shape and propose `DROP COLUMN
destination_id` / `DROP COLUMN vehicle_type` / `DROP COLUMN vehicle_type_requested` with **no
backfill in between** — silent data loss on any environment that has rows. The correct process
is the one `0018`'s own CHECK-tightening migration already used: hand-author the SQL (the exact
statements below), then hand-append the matching journal entry and snapshot, or generate via
drizzle-kit's custom-migration path and edit the resulting empty file before it's ever applied.
**Do not run plain `db:generate` from the finished `schema.ts` and trust its output for any of
0023–0029.**

**MySQL DDL is not transactional.** Each `ALTER TABLE` auto-commits individually, so a failure
partway through (say, 0028 step 5) leaves `bookings` with the CHECK dropped and both the old
and new columns present. Each multi-step migration file in this note needs a comment stating
the safe recovery point, and migrations run **with the app server stopped**, exactly as any
other migration here already requires (`pnpm --filter @rg/server db:migrate`, never against a
live-traffic process).

**Ruling: 1A and 1B commit non-green by construction; only 1C's commit is checked.** Drizzle
generates TypeScript types directly from `schema.ts`, so the moment `vans.vehicleType` /
`bookings.vehicleTypeRequested` are renamed, every direct consumer across `shared/`, `server/`,
and `client/` fails to typecheck in the same instant — there is no way to split "schema" from
"its immediate consumers" into independently-green commits, confirmed by grepping the real
blast radius (23 files reference `VEHICLE_TYPES`/`VehicleType` today). 1A's and 1B's commits are
therefore **reviewable units, not independently-verifiable ones** — each gets its own commit and
its own dedicated review question (did the migration SQL get the real constraint names and the
real ordering right; did the capacity/pricing/dispatch generalization get the key-set math
right), but neither is asked to pass `pnpm typecheck`/`pnpm test` standalone. The five checks run
once, after 1C's shared/tRPC layer makes the whole repo compile again, and gate 1C's commit. If
they fail, the fix lands as a new commit on top rather than rewriting 1A/1B's history.

**Every backfill below is a guaranteed no-op in production today.** Migrations 0015–0022 are
still unapplied on the server (HANDOVER-4). `transfer_routes` does not exist there at all, so
§1.2/§1.3/§1.4's data migrations have nothing to move on first deploy — they only do real work
on a dev box that already created routes locally. Stated as a fact, not a hedge: "0 rows today,
measured" undersells it; production has no table yet.

---

## 1. New/changed tables

### 1.1 `vehicle_types` (new)

```
vehicle_types
  id              PK, autoincrement
  name            varchar(80)  NOT NULL
  slug            varchar(40)  NOT NULL UNIQUE
  default_seats   int, NULLABLE     -- prefill only; a VAN's own `vans.capacity` is authoritative
  default_luggage int, NULLABLE     -- prefill only; a VAN's own `vans.luggage_capacity` is authoritative
  is_active       boolean NOT NULL DEFAULT true
  sort_order      int NOT NULL DEFAULT 0
  created_at / updated_at
```

`default_seats`/`default_luggage` are **prefill values for the admin "add van" form only** —
they never feed capacity or the seat/luggage soft-check at dispatch, which already reads each
van's own `capacity`/`luggage_capacity` (0C, pre-existing, unchanged). This is why they are
nullable: the two backfilled rows (`van`, `suv`) genuinely don't have a single "default" seat
count worth inventing — existing vans already carry their own real numbers — so the migration
leaves both NULL rather than guessing. 1G's demo rows (Van/SUV/MPV) fill them in because the
demo fleet below is built around them.

**Migration (0023):** `CREATE TABLE vehicle_types (...)`, then two INSERTs, in this order so
`'van'` gets the lower id deterministically on a fresh table (both `rg_travel` and
`rg_travel_test` create this table for the first time in this migration — no prior data to
reconcile):

```sql
INSERT INTO vehicle_types (name, slug, is_active, sort_order) VALUES ('Van', 'van', true, 0);
INSERT INTO vehicle_types (name, slug, is_active, sort_order) VALUES ('SUV', 'suv', true, 1);
```

No `.default()` on any later FK column references these ids by number — every later migration
backfills by **joining on `slug`**, never a literal id, so the insert order above is a
determinism nicety (so `van` reads as "the first vehicle type" in an admin list), not a
correctness dependency.

### 1.2 `transfer_places` (new)

```
transfer_places
  id              PK, autoincrement
  name            varchar(120) NOT NULL
  name_key        varchar(160) NOT NULL UNIQUE   -- trim(name).toLowerCase(), written by the service
  is_airport      boolean NOT NULL DEFAULT false
  is_active       boolean NOT NULL DEFAULT true
  sort_order      int NOT NULL DEFAULT 0
  destination_id  int NULLABLE, FK -> destinations.id   -- optional cross-link, see below
  created_at / updated_at
```

**`name_key` is an explicit, service-written normalized column — not a reliance on column
collation.** This project has twice been burned by assuming a column's default collation gives
case-insensitive matching "for free" (BUG-107 `coupons.code`, BUG-108 `bookings.ref` — both
fixed by moving the normalization into the Zod schema, `.transform().pipe()`, rather than
leaning on `_ci_` collation again). "Unique case-insensitively after trimming" (owner decision
1) gets the same treatment here: `upsertTransferPlace()` (the one writer, mirroring
`upsertTransferRoute()`'s own "one writer" discipline) computes `name_key =
name.trim().toLowerCase()` and the UNIQUE index on that column is what actually enforces it,
concurrency-safe, independent of whatever collation MySQL happens to default to. A duplicate
`ER_DUP_ENTRY` on `name_key` is translated into a guest/admin-safe conflict message the same way
`upsertTransferRoute()` already translates `ER_DUP_ENTRY` on `slug`/`destination_id`.

**`destination_id` is nullable, and that is forced, not aesthetic.** "Mactan-Cebu International
Airport" and "Hagnaya Port" have no matching row in `destinations` (that table is tour
destinations: Moalboal, Oslob, etc.) — a NOT NULL FK here would make every airport/port place
unrepresentable. Owner decision 1's "optional link... if useful" is read as: **informational
only**, for a future "see the Moalboal page" cross-link if someone wants one — it is never
consulted by sellability, pricing, or capacity logic, and it is explicitly **not** how "adding a
place creates a public page" is prevented (decision 1's own DO-NOT). What actually prevents that:
`transfer_places` has no slug route, no SEO resolver entry, no sitemap entry, and no public page
component anywhere in this plan — it is a flat admin list consumed only by the transfer-route
form's combobox and by the public route list's denormalized place names. Nothing renders
`/destinations/:placeSlug`.

**Migration (0024):** `CREATE TABLE transfer_places (...)`, then a data migration driven
entirely by what `transfer_routes` already contains (0 rows today, measured — Batch 4b never
created a real route; T26/1G's demo rows don't exist yet either):

```sql
-- Only if at least one transfer_routes row exists. Creates nothing on a fresh/empty table.
INSERT INTO transfer_places (name, name_key, is_airport, is_active, sort_order)
SELECT 'Mactan-Cebu International Airport', 'mactan-cebu international airport', true, true, 0
WHERE EXISTS (SELECT 1 FROM transfer_routes);

-- INSERT IGNORE, not a plain INSERT: two destinations differing only in case/whitespace (or
-- one that happens to collide with the airport row above) would otherwise abort the whole
-- migration on the name_key UNIQUE. A collision here means two destinations would have
-- resolved to the "same place" anyway — acceptable at a one-off backfill where today's data
-- has zero destinations, and `GROUP BY name_key` is an equally valid alternative if a reviewer
-- prefers an explicit dedup over a silent skip. Either way, `name_key`'s normalization is a
-- ONE-OFF here; the SERVICE (`upsertTransferPlace()`) is the normalizer for every write after
-- this migration, never raw SQL again.
INSERT IGNORE INTO transfer_places (name, name_key, is_airport, is_active, sort_order, destination_id)
SELECT d.name, LOWER(TRIM(d.name)), false, d.is_active, d.sort_order, d.id
FROM destinations d
WHERE d.id IN (SELECT DISTINCT destination_id FROM transfer_routes);
```

Both branches are no-ops against today's empty `transfer_routes` table — confirmed by the
backfill test covering **both** the zero-rows case (nothing created, migration succeeds) and a
seeded-rows case (a test-only fixture row inserted before running this migration in isolation,
proving the airport place and the per-destination place both appear, case-insensitively keyed).
1G's demo places (Cebu City, Moalboal, Oslob, Hagnaya Port, and the same airport row reused by
natural key) go through `seedDemo`, app-context only, **never** through this migration or
`seedBase` — this migration's job is existing-row preservation, not demo content.

### 1.3 `transfer_routes` (restructured)

```
transfer_routes
  id                          PK            (unchanged)
  from_place_id               int NOT NULL, FK -> transfer_places.id     -- NEW, replaces destination_id
  to_place_id                 int NOT NULL, FK -> transfer_places.id     -- NEW
  reverse_enabled             boolean NOT NULL DEFAULT true              -- NEW (owner decision 2)
  slug                        varchar(80) UNIQUE                         (unchanged)
  is_active                   boolean DEFAULT true                       (unchanged)
  sort_order                  int                                        (unchanged)
  estimated_duration_minutes  int NOT NULL                                (unchanged — still minutes;
                                                                             1D's hours+minutes input
                                                                             is a UI nicety, Architecture
                                                                             §2's frozen-duration
                                                                             behaviour is untouched)
  free_cancel_hours           int NOT NULL DEFAULT 24                     (unchanged)
  inclusions_text / exclusions_text                                      (unchanged)
  created_at / updated_at                                                 (unchanged)

  UNIQUE (from_place_id, to_place_id)     -- replaces the old UNIQUE(destination_id)
  -- destination_id column and its FK/UNIQUE: DROPPED
```

**Sellability rule moves here from `destinations` to places** (owner decision 2, explicitly
superseding the 2026-11-06 owner decision that put it on `destinations`): a route is sellable
only if **the route itself** AND **both `from_place` and `to_place`** are active. This is the
"0D" rule (`vehiclePriceForRouteAndType`'s join to `destinations.is_active`,
`transferRoutes.list`'s filter) — it gets **retargeted, not duplicated**: the existing join
becomes two joins (`fromPlace`, `toPlace`) both requiring `is_active = true`, and the existing
tests that pin "destination inactive hides the route"
(`admin-transfer-routes.test.ts`, `transfer-pricing.test.ts`,
`transfer-create-booking.test.ts`, `checkout-create-hold-transfer.test.ts`,
`public-queries.test.ts`) are rewritten to set up an inactive **place** instead of an inactive
destination, asserting the identical refusal shapes. No test is deleted; each is retargeted at
its new input.

**Migration (0025), in this exact order** (the dedicated reviewer's first thing to check —
getting this order wrong either fails outright or silently drops the uniqueness guarantee for a
window):

1. `ALTER TABLE transfer_routes ADD COLUMN from_place_id INT NULL, ADD COLUMN to_place_id INT NULL, ADD COLUMN reverse_enabled BOOLEAN NOT NULL DEFAULT true;`
2. Backfill, by natural-key lookup (never a literal id):
   ```sql
   UPDATE transfer_routes r
   JOIN transfer_places airport ON airport.name_key = 'mactan-cebu international airport'
   JOIN destinations d ON d.id = r.destination_id
   JOIN transfer_places dest ON dest.name_key = LOWER(TRIM(d.name))
   SET r.from_place_id = airport.id, r.to_place_id = dest.id;
   ```
   (Every existing route becomes airport→destination, reverse ON — matching how the
   2026-10-31 plan already modeled "either direction" as one row. No existing data is lost:
   every route that resolved under the old `destination_id` model resolves to the identical
   from/to pair under the new one.)
3. `ALTER TABLE transfer_routes MODIFY from_place_id INT NOT NULL, MODIFY to_place_id INT NOT NULL;`
   (safe post-backfill; 0 existing rows today makes this step a no-op to verify, so the test
   must also exercise it against a seeded row, same as 1.2's backfill test.)
4. `ALTER TABLE transfer_routes ADD CONSTRAINT transfer_routes_from_place_fk FOREIGN KEY (from_place_id) REFERENCES transfer_places(id), ADD CONSTRAINT transfer_routes_to_place_fk FOREIGN KEY (to_place_id) REFERENCES transfer_places(id);`
5. **Drop the old FK before touching its backing index** — `destination_id` is
   `.notNull().unique().references(destinations.id)`, and the UNIQUE index IS the FK's backing
   index. Dropping the unique index while the FK still points at it fails in MySQL. `transfer_routes`
   and `transfer_route_vehicle_prices` were both created in **`0016_salty_skreet.sql`**
   (not 0017 — 0017 only added `bookings.route_id`/`vehicle_type_requested`/the CHECK), and that
   file names both constraints explicitly rather than letting Drizzle pick at generate time:
   ```sql
   ALTER TABLE transfer_routes DROP FOREIGN KEY transfer_routes_destination_id_destinations_id_fk;
   ALTER TABLE transfer_routes DROP INDEX transfer_routes_destination_id_unique;
   ALTER TABLE transfer_routes DROP COLUMN destination_id;
   ```
   (General rule restated, since this note got the file wrong on its first pass: **read the
   real name from the migration file that created the constraint, never guess it** — guessing
   is exactly the mistake this note itself made here before review.)
6. `ALTER TABLE transfer_routes ADD CONSTRAINT transfer_routes_from_to_unique UNIQUE (from_place_id, to_place_id);`

### 1.4 `transfer_route_vehicle_prices` (restructured)

```
transfer_route_vehicle_prices
  route_id                FK -> transfer_routes.id        (unchanged)
  vehicle_type_id         FK -> vehicle_types.id           -- NEW, replaces the `vehicle_type` enum
  one_way_price_centavos  int NOT NULL                     (unchanged)
  day_use_price_centavos  int NOT NULL                     (unchanged)
  PK (route_id, vehicle_type_id)
  -- the `vehicle_type` enum column: DROPPED
```

**The table's own schema comment currently says "exactly two rows per route (van, suv), never
more, never fewer."** Owner decision 4 directly reverses this: **"a price row for any active
vehicle type... No row = that type isn't offered on that route."** This is a stated **new
product rule**, not a weakened assertion — the replacement invariant is "at most one row per
`(route_id, vehicle_type_id)`, and zero or more rows total per route," still enforced by the
same composite PK (which forbids a *second* row for one type, unchanged) plus the new freedom
that the *count* of rows is no longer fixed at two. `upsert-route.ts`'s delete-then-reinsert
stays wholesale-safe for the same reason it always was (nothing references this table with a
FK — a price snapshot freezes the price, not a pointer to this row).

**The completeness contract that made the old delete-then-reinsert safe for money must be
RESTATED, not silently dropped (Opus review finding).** Today, `TransferRouteCreateInput.prices`
is `{ van, suv }` with both halves structurally required, and `mergeTransferRoutePatch` can only
omit `prices` ENTIRELY (never half of it) — a `VEHICLE_TYPES.map(...)` compile-time link is what
guarantees the re-insert always restates both rows. A sparse `Record<number, PriceRow | null>`
breaks that link: a caller could send `{ 3: {...} }` meaning "set MPV's price" and accidentally
wipe Van's and SUV's existing rows, with nothing at compile time to catch it. The replacement
contract, to be implemented in 1B/1C and tested in 1D:

- **A present `prices` object in a `create`/`update` call is read as the COMPLETE price card
  for that route** — every active vehicle type the admin wants offered, keyed by id, with a
  type simply absent from the object meaning "not offered" (one price row deleted or never
  created), not "leave whatever was there." There is no partial-patch form of `prices`: an
  `update` either omits the key entirely (keep the stored card unchanged, exactly as today) or
  sends the whole new card.
- Because the compile-time guarantee is gone, a **runtime check replaces it**: the admin
  route form (1D) always posts every active vehicle type's price pair (blank input = that key
  present with `null`, meaning "no row"), never a hand-trimmed subset, and a server-side test
  (1F) pins "a patch naming only one type's price does not silently remove any other type's
  existing row" by asserting the OTHER rows are untouched after such a save.
- `missingPricesMessage` and the router's existing `CONFLICT` refusal
  (`transfer-routes.ts:236–240`, pinned today by `admin-transfer-routes.test.ts:581` asserting
  exactly `['suv','van']`) **no longer apply** — there is nothing "missing" about a route with
  zero price rows under the new rule, so that refusal is removed, and the pinned assertion is
  rewritten to the new contract (a route may legitimately save with any subset of active types
  priced, including none).
- **New refusal: `fromPlaceId === toPlaceId` is refused** (`BAD_REQUEST`, "a route cannot start
  and end at the same place") — nothing in the schema (a plain `UNIQUE(from_place_id,
  to_place_id)`) prevents a self-referencing route otherwise, and the pre-write existence check
  that currently validates `destinationId` must be extended to validate both `fromPlaceId` and
  `toPlaceId` exist before any write, exactly as it does today for the single destination.

**Migration (0026), PK swap — backfill before the PK (a PK cannot be declared over a NULL), and
drop the `route_id` FK before the PK (corrected after Opus review: 0016 created
`PRIMARY KEY(route_id, vehicle_type)` and then added
`transfer_route_vehicle_prices_route_id_transfer_routes_id_fk` by a later `ALTER`, which made
InnoDB reuse the PK as that FK's OWN backing index rather than building a second one. Dropping
the PK with that FK still pointing at it fails: `ERROR 1553 (HY000): Cannot drop index
'PRIMARY': needed in a foreign key constraint`. The original draft of this note missed this and
would have failed at exactly this step.):**

1. `ALTER TABLE transfer_route_vehicle_prices ADD COLUMN vehicle_type_id INT NULL;`
2. `UPDATE transfer_route_vehicle_prices p JOIN vehicle_types vt ON vt.slug = p.vehicle_type SET p.vehicle_type_id = vt.id;`
3. **Assert the backfill is total before trusting it:**
   `SELECT COUNT(*) FROM transfer_route_vehicle_prices WHERE vehicle_type_id IS NULL;` must
   return 0. This is not optional under non-strict `sql_mode`: step 4's `MODIFY ... NOT NULL`
   would otherwise silently coerce any leftover NULL to `0`, and on a money table that becomes
   a PK collision at `(route_id, 0)` for every unresolved row instead of a clean failure here.
4. `ALTER TABLE transfer_route_vehicle_prices MODIFY vehicle_type_id INT NOT NULL;`
5. `ALTER TABLE transfer_route_vehicle_prices DROP FOREIGN KEY transfer_route_vehicle_prices_route_id_transfer_routes_id_fk;`
6. `ALTER TABLE transfer_route_vehicle_prices DROP PRIMARY KEY;`
7. `ALTER TABLE transfer_route_vehicle_prices DROP COLUMN vehicle_type;`
8. `ALTER TABLE transfer_route_vehicle_prices ADD PRIMARY KEY (route_id, vehicle_type_id);`
9. Re-add **both** foreign keys — the `route_id` one this sequence just dropped, and the new
   `vehicle_type_id` one:
   ```sql
   ALTER TABLE transfer_route_vehicle_prices
     ADD CONSTRAINT transfer_route_vehicle_prices_route_id_transfer_routes_id_fk
       FOREIGN KEY (route_id) REFERENCES transfer_routes(id),
     ADD CONSTRAINT transfer_route_vehicle_prices_vehicle_type_fk
       FOREIGN KEY (vehicle_type_id) REFERENCES vehicle_types(id);
   ```

### 1.5 `vans.vehicle_type` → `vans.vehicle_type_id`

```
vans
  vehicle_type_id   int NOT NULL, FK -> vehicle_types.id    -- replaces vehicle_type enum
  -- no column-level DEFAULT going forward: every new van create must choose a type
  -- explicitly, exactly as `vanInputSchema`'s current comment already requires at the
  -- Zod layer — this migration just makes the DB agree
```

**Migration (0027):**

1. `ALTER TABLE vans ADD COLUMN vehicle_type_id INT NULL;`
2. `UPDATE vans v JOIN vehicle_types vt ON vt.slug = v.vehicle_type SET v.vehicle_type_id = vt.id;`
3. `ALTER TABLE vans MODIFY vehicle_type_id INT NOT NULL;`
4. `ALTER TABLE vans ADD CONSTRAINT vans_vehicle_type_fk FOREIGN KEY (vehicle_type_id) REFERENCES vehicle_types(id);`
5. `ALTER TABLE vans DROP COLUMN vehicle_type;`

Every `.insert(vans).values(...)` call site that compiled today because of the enum's
`.default('van')` **must be updated to pass `vehicleTypeId` explicitly** — there is no
equivalent default once the column is a bare FK with no admin-meaningful "default vehicle type."
1B's grep-for-literals pass (§3 below) is also the sweep that finds every one of these call
sites (seed data, test fixtures, the admin create path).

### 1.6 `bookings.vehicle_type_requested` → `bookings.vehicle_type_id` — the CHECK-constrained one

**This is the migration's hardest step.** `vehicle_type_requested` is named inside the
`bookings_product_type_shape` CHECK (`db/schema.ts` ~1351–1359). MySQL refuses to drop or
retype a column a CHECK constraint references, so the CHECK has to come off before the column
changes and go back on, rewritten, afterward — and the rewritten CHECK must substitute the new
column name in **both** branches, or the "a tour never carries a transfer column" half of the
invariant silently stops being enforced with nothing to flag it.

```
bookings
  vehicle_type_id   int NULLABLE, FK -> vehicle_types.id    -- replaces vehicle_type_requested
```

**Migration (0028), in order.** The CHECK's unenforced window is kept to the two statements
that genuinely need it gone (corrected after Opus review — the first draft dropped it as step 1
and left the invariant unenforced for the whole migration; nothing between the ADD COLUMN and
the backfill actually needs it gone):

1. `ALTER TABLE bookings ADD COLUMN vehicle_type_id INT NULL;`
2. `UPDATE bookings b JOIN vehicle_types vt ON vt.slug = b.vehicle_type_requested SET b.vehicle_type_id = vt.id WHERE b.vehicle_type_requested IS NOT NULL;`
3. `ALTER TABLE bookings ADD CONSTRAINT bookings_vehicle_type_fk FOREIGN KEY (vehicle_type_id) REFERENCES vehicle_types(id);`
4. `ALTER TABLE bookings DROP CONSTRAINT bookings_product_type_shape;` (verified against the
   real `0018_tricky_lady_ursula.sql` text — `DROP CONSTRAINT` is the exact spelling that
   created it, not `DROP CHECK`)
5. `ALTER TABLE bookings DROP COLUMN vehicle_type_requested;`
6. Re-add the CHECK with `vehicle_type_id` substituted for `vehicle_type_requested` — verified
   character-for-character against 0018's real text with only the column renamed, **the
   asymmetry about `route_id` preserved exactly as today** (tour branch: NULL on both transfer
   columns; transfer branch: says nothing about `route_id`, only requires `vehicle_type_id IS
   NOT NULL`):
   ```sql
   ALTER TABLE bookings ADD CONSTRAINT bookings_product_type_shape CHECK (
     (product_type = 'tour' AND tour_id IS NOT NULL
       AND vehicle_type_id IS NULL AND route_id IS NULL)
     OR
     (product_type <> 'tour' AND tour_id IS NULL AND vehicle_type_id IS NOT NULL)
   );
   ```

`schema-bookings.test.ts` (or wherever the raw-INSERT CHECK-proving tests for this constraint
live today) gets a mutation check specifically for this: re-run the OLD two-branch assertions
against the NEW column name and confirm a raw INSERT with `vehicle_type_id` set on a `tour_id
IS NOT NULL` row is still refused by the database, not just by application code — this is the
one place a "the column got renamed but the CHECK quietly didn't" regression would hide.

### 1.7 `booking_transfer_details.direction` (new column)

```
booking_transfer_details
  direction   enum('forward','reverse') NOT NULL DEFAULT 'forward'   -- NEW
```

**One column, not a signed route id and not a second route row.** "Forward" is `from_place_id →
to_place_id` as the route is stored; "reverse" is the same route, same price, same duration
(owner decision 2: "also bookable in reverse... same prices and duration"), travelled the other
way. `direction` is purely a **label** for which place is the effective pickup vs. drop-off in
guest-facing copy (receipts, notifications, the admin booking screen) — it changes no money, no
duration, and no capacity math (a window is still `[pickup_time, pickup_time + duration +
buffer)` regardless of direction). A reverse hold on a route with `reverse_enabled = false` is
refused by `createTransferBooking()` the same way an unpriced vehicle type is — a new
`TransferBookingShapeError` reason, `reverse_not_enabled_for_route`.

**Migration (0029):** `ALTER TABLE booking_transfer_details ADD COLUMN direction ENUM('forward','reverse') NOT NULL DEFAULT 'forward';` — a pure additive column, default-backfills every existing row (there are none today) to `'forward'`, which is correct: every route built under the old model only ever had one sellable direction before this plan, and that direction is what `'forward'` now names.

### 1.8 Price snapshot — additive only, legacy reads preserved

`TransferPriceSnapshot` (`shared/src/booking.ts`) currently freezes `vehicleType: 'van' | 'suv'`
(the literal string) on every transfer booking ever created. **This is an immutable record and
is never rewritten.** Going forward:

- The schema gains `vehicleTypeId: z.number().int().positive().optional()` and
  `vehicleTypeName: z.string().optional()` (the frozen display name, same freezing discipline
  the snapshot already applies to everything else — an admin renaming or deactivating a vehicle
  type later must not change what an old receipt says).
- `vehicleType` (the legacy string literal) stays in the schema as `z.string().optional()` —
  loosened from the old two-literal enum to a bare optional string, because **no new write ever
  produces a value in this field**, only old rows have one, and a schema that still enforced
  `'van' | 'suv'` on a field nothing writes would be dead weight that happens to still parse.
- `buildTransferSnapshot()` (the only writer, `create-booking.ts`) stops writing `vehicleType`
  entirely and always writes `vehicleTypeId` + `vehicleTypeName` instead.
- **One reader helper**, `transferSnapshotVehicleTypeLabel(snapshot): string`, is the single
  place every display surface (receipts, portal, admin, notifications) asks "what vehicle type
  was this": `vehicleTypeName ?? (vehicleType ? titleCase(vehicleType) : 'Vehicle')`. No surface
  hand-rolls this fallback a second time — the same discipline `TRANSFER_BOOKING_LABEL` already
  established for "what do we call a transfer booking with no tour." (Measured during review:
  **nothing in the codebase today reads `snapshot.vehicleType`** — `dispatch/assign.ts` reads
  the `bookings.vehicle_type_id` COLUMN, not the snapshot — so this helper is forward-looking
  plumbing for T22/T23/T24's display surfaces, not a fix for an existing reader.)
- **Hardening (Opus review):** with `vehicleType`, `vehicleTypeId` and `vehicleTypeName` all
  `.optional()`, a snapshot carrying NONE of the three still parses cleanly, and the helper's
  `?? 'Vehicle'` fallback would hide that forever rather than surfacing a bug. Add a
  `.refine((s) => s.vehicleTypeId !== undefined || s.vehicleType !== undefined, 'a transfer
  snapshot must carry either a legacy vehicleType or a vehicleTypeId')` to
  `transferPriceSnapshotSchema` so a snapshot with neither fails to write, the same discipline
  every other required-in-spirit field on this schema already gets.
- **Right-sized acceptance criterion (corrected after review — the first draft overstated what
  needs proving):** since nothing today reads the snapshot's vehicle-type field at all, 1F's
  "existing van/suv bookings still render" criterion reduces to two provable facts, not three:
  (a) a **pre-migration-shaped** snapshot (literal `vehicleType: 'van'`, no `vehicleTypeId`)
  still parses under the updated, `.refine()`-guarded Zod schema, and (b) `bookings
  .vehicle_type_id` is correctly backfilled for every pre-existing transfer booking (§1.6's
  migration test already covers this) — dispatch and every other consumer of "what vehicle type
  is this booking" read the column, not the snapshot, so (b) alone is what keeps them working.
  The label helper resolving a legacy snapshot to `"Van"` is nice-to-have UI correctness, tested
  alongside T22/T23/T24 when those tasks actually call it, not a schema-level blocker here.

---

## 2. Services and procedures — what changes

| File | Change |
| --- | --- |
| `server/src/db/schema.ts` | §1's six table changes (new `vehicleTypes`, `transferPlaces`; restructured `transferRoutes`, `transferRouteVehiclePrices`, `vans`, `bookings`; new `booking_transfer_details.direction`) |
| `shared/src/transfers.ts` | `VEHICLE_TYPES`/`VehicleType` **removed**. `quoteTransferInput.vehicleType: z.enum(VEHICLE_TYPES)` → `vehicleTypeId: z.number().int().positive()`. `TransferRoutePublicRow.prices: Record<VehicleType, ...>` → `vehiclePrices: TransferRoutePublicVehiclePrice[]` (one entry per offered type, each carrying `vehicleTypeId`, `vehicleTypeName`, `slug`, both prices) — see §4 for the sellability filter this list applies. New `fromPlace`/`toPlace`/`reverseEnabled` fields replacing `destinationName`. |
| `shared/src/transfers-admin.ts` | Admin route input's `prices: { van, suv }` (fixed shape) → `prices: Record<number, { oneWayPriceCentavos, dayUsePriceCentavos } | null>` keyed by vehicle-type id, sparse. New Zod inputs for `vehicleTypeCreateInput`/`transferPlaceCreateInput` (name/slug/seats/luggage/active/sort; name/isAirport/active/sort respectively). |
| `shared/src/booking.ts`, `shared/src/dispatch.ts` | Every `z.enum(VEHICLE_TYPES)` → `z.number().int().positive()` (vehicle-type id). `TransferPriceSnapshot` per §1.8. |
| `server/src/services/transfers/overlap.ts` | **Untouched.** `peakOverlap`/`overlaps` operate on plain `{start,end}` windows and know nothing about vehicle types — no change needed. |
| `server/src/services/transfers/capacity.ts` | The generalization. `SellableVehicleCounts`/`TransferWindowsByType` go from `Record<VehicleType, number \| TimeWindow[]>` (fixed `{van, suv}`) to `Map<number, number \| TimeWindow[]>` keyed by `vehicle_type_id`. **Corrected key-set derivation (Opus review found the first draft's "union of active-sellable and booked" formulation has a hole):** compute `windows` FIRST (every capacity-holding transfer booking's window, grouped by type id) and push the CANDIDATE's own window into its type's bucket, exactly as today's `van`/`suv` code already does — THEN the key set is `keys(windows) ∪ keys(sellable)`, with `sellable` carrying an explicit `0` entry for any id present in `windows` but absent from the sellable-counts query (a type with zero sellable vehicles still needs a `0`, not a missing key, or a type-short candidate is checked against nothing and accepted). Because the candidate's own window is already in `windows` before the key set is computed, the candidate's type is IN the set by construction — the earlier draft's formulation ("active types with ≥1 sellable van" ∪ "types claimed by EXISTING bookings") could leave the key set empty when a candidate requests a type with zero sellable vehicles and zero existing bookings, which would make conditions (1)/(2) pass vacuously and accept a hold with no vehicle in the fleet at all. Conditions (1)–(3) generalize from two named branches to a loop over the corrected key set; condition (3)'s `leftoverVehicles` becomes a sum over the same set. The existing comment that a type whose peak exceeds its sellable count "contributes a NEGATIVE term; left unclamped on purpose" must survive into the loop unchanged — it now fires more often with N types, which is correct, not a regression. §2a (driver conditions 4/5) has **no vehicle-type dimension and is untouched** — drivers remain one undifferentiated pool regardless of how many vehicle types exist. |
| `server/src/services/transfers/pricing.ts` | `vehiclePriceForRouteAndType(routeId, vehicleTypeId, productType, db)` — `vehicleType: VehicleType` param becomes `vehicleTypeId: number`. The `innerJoin(destinations, ...)` sellability join becomes two ALIASED joins to `transfer_places` (`alias(transferPlaces, 'fromPlace')`/`alias(transferPlaces, 'toPlace')` from `drizzle-orm/mysql-core` — two unaliased joins to the same table is invalid SQL), both requiring `is_active = true` — the retargeted "0D" rule (§1.3). **Also joins `vehicle_types` and requires `vehicle_types.is_active = true` (Opus review finding, not in the first draft)** — without this, an admin deactivating a vehicle type leaves its price rows in place and a stale tab or direct tRPC call with that type's id still gets quoted and held, the identical disclosure the T9 review already fixed once for destinations (`pricing.ts`'s own doc comment: "a live price for a place the business has withdrawn, reachable from a stale tab or by probing small route ids"). The money path must check the type's own `is_active`, not only the public list (§4). `transferRoutes.list`'s existing `orderBy(asc(transferRoutes.sortOrder), asc(destinations.name))` becomes `asc(toPlace.name)` (the destination side of the pair, matching what the old ordering actually sorted by). |
| `server/src/services/transfers/create-booking.ts` | `CreateTransferBookingInput.vehicleType: VehicleType` → `vehicleTypeId: number`; new `direction: 'forward' \| 'reverse'` field (lives on the HOLD input, `shared/src/transfers-checkout.ts` — see that file's row below — never on `quoteTransferInput`, matching that file's own "a quote names a product, a hold describes a journey" rule), validated against the route's `reverseEnabled` before the capacity check (new error reason `reverse_not_enabled_for_route` — documented as checked AFTER the catalog read, since `assertBookableShape`'s doc comment currently promises every one of its checks runs pre-transaction with no database; this one and the flight-fields one below are the two exceptions, and both get their own doc note saying so rather than silently violating that promise). New post-catalog-read check (inside the transaction, right after step 3a's catalog fetch, which now also selects `fromPlace.isAirport`/`toPlace.isAirport`): if either place is an airport and `productType === 'transfer_one_way'`, `flightNumber`/`airline` must both be present — flagged in §6 below as an open question for the owner, since it refuses some requests that are bookable today. `buildTransferSnapshot()` per §1.8. |
| `server/src/services/dispatch/availability.ts` **and** `server/src/services/dispatch/assign.ts` | `vansFreeOn(opts?.vehicleType: VehicleType)` → `opts?.vehicleTypeId: number`; `vanBaseClauses` filters on `vans.vehicleTypeId`. **`assign.ts` is a required change site the first draft omitted** — it reads `bookings.vehicleTypeRequested` and feeds `vansFreeOn({ vehicleType })` at several call sites; every one becomes `vehicleTypeId`. No change to the window-overlap logic itself. |
| `shared/src/transfers-checkout.ts` | **Required change site the first draft omitted.** `createHoldTransferInput` extends `quoteTransferInput`'s `vehicleTypeId`; the new `direction: z.enum(['forward','reverse'])` field is added HERE, not on `quoteTransferInput` — a quote names a product (route + type + product type), a hold describes a journey (which way it's travelled). |
| `server/src/routers/public/checkout.ts` | **Required change site the first draft omitted.** Passes `input.vehicleType`/`input.direction` through to `createTransferBooking`; both call sites (quote and hold) updated for the renamed/new fields. |
| `server/src/routers/public/transfers.ts` | `transferRoutes.list` builds `vehiclePrices` per §4's filter (now correctly joining `vehicle_types.is_active`, per the pricing.ts row above); resolves both directions when `reverseEnabled`. New `vehicleTypes.list` (public, active only) for the guest vehicle picker. |
| `server/src/routers/admin/transfer-routes.ts`, `server/src/services/transfers/upsert-route.ts` | Route create/update takes `fromPlaceId`/`toPlaceId`/`reverseEnabled`; price card keyed by vehicle-type id, sparse but COMPLETE per §1.4's restated completeness contract. Duplicate-key message covers `(from_place_id, to_place_id)` instead of `destination_id`. New refusal: `fromPlaceId === toPlaceId`. Pre-write existence check validates both place ids (not just one), mirroring today's single `destinationId` check. |
| `server/src/routers/admin/vehicle-types.ts` (new) | `admin.vehicleTypes.*` — list/create/update/setActive. Gated `adminProcedure('toursPricing')` — **no new `ROLE_MATRIX` area**; this reuses the same owner-only area the existing transfer-routes admin already uses. |
| `server/src/routers/admin/transfer-places.ts` (new) | `admin.transferPlaces.*` — same gating, same pattern. |
| `server/src/routers/admin/vans.ts` | `vehicleType` field → `vehicleTypeId`. |
| `server/src/db/seed-data.ts` | `seedBase`: no transfer content (unchanged — transfers are demo-only today, matching tours/packages/reviews). `seedDemo`: 1G's places/routes/prices/fleet, app-context only. **`upsertFleet` (`seed.ts:416`) currently omits `vehicleType` entirely and relies on the enum's `.default('van')` — confirmed by review this is not merely a runtime risk but a `pnpm typecheck` FAILURE once the default is removed (a required FK column with no default), so this call site must be fixed in the same commit as the schema change, not discovered later.** |
| Client (1D/1E implementers' own reconnaissance, named here so the sweep isn't missed): `RoutePicker.tsx`, `VehicleOptionCard.tsx`, `TransferGuestDetailsForm.tsx`, `TransferBookingPage.tsx`, `AdminVansPage.tsx`, `AdminTransferRoutesPage.tsx` | Every fixed `'van'/'suv'` branch or two-element assumption becomes a render over the dynamic vehicle-types list. |

**The 1B grep test ("no `'van'`/`'suv'` literals left in logic") needs a declared scope,
stated in the test itself**, because several places legitimately still contain those strings:
the migration files (data backfill joins on `slug = 'van'`-shaped literals), `seed-data.ts`
(the two slugs are real natural keys, not magic strings), and the snapshot back-compat reader
(§1.8's legacy `vehicleType` field and its title-casing fallback, which must keep recognizing
the literal strings forever to render old bookings). The test scopes itself to
`server/src/services/transfers/**`, `server/src/services/dispatch/**`, and
`server/src/services/capacity.ts`, with an explicit exclusion list naming the snapshot
back-compat file and the migration folder — not a bare repo-wide grep.

---

## 3. What does NOT change

- Availability math (Architecture §2/§2a's five conditions, the interval-scheduling and
  exchange-argument proofs) — only its *keys* generalize from two literals to N ids.
- Lock order (`fleet_date_slots` → `tour_date_slots` → booking row) and the "take the lock
  before reading" rule.
- Money math: centavos, server-computed, price lock at hold time, the ₱100 floor, the ₱0
  refusal, deposit rules. A transfer's price is still a flat per-vehicle rate; nothing here
  changes who multiplies what.
- `amount_paid_centavos`'s single writer (`record-payment.ts`).
- Soft-delete discipline — `vehicle_types`, `transfer_places`, `transfer_routes` all deactivate,
  never delete; the same is true of their existing siblings.
- `ROLE_MATRIX` — no new area. Places/vehicle-types/routes admin all reuse `toursPricing`
  (owner-only), identical to how routes admin already works today.
- The duration-freezing behaviour of migration 0020 (`booking_transfer_details
  .route_duration_minutes_used`) and the buffer-freezing behaviour — both untouched; `direction`
  is a new, independent frozen field alongside them, not a replacement for either.

---

## 4. Public visibility rule (owner decision 4, second half)

"Guests only see types that have a price AND have at least one sellable vehicle of that type"
is **new scope**, not a restatement of something that already existed — today's public route
row shows a price (or `null`) with no fleet-sellability filter at all. `transferRoutes.list`'s
`vehiclePrices` array is therefore built as:

```
for each vehicle type with an active row in vehicle_types:
  if transfer_route_vehicle_prices has a row for (route, that type)
     AND sellableVehiclesByType()[that type] >= 1:
    include it
```

This reuses `sellableVehiclesByType()` from `services/transfers/capacity.ts` rather than a
second fleet count — **but its signature must widen first (Opus review finding, not "already
correct" as the first draft claimed).** Today it takes `(tx: Transaction)` only, and
`transferRoutes.list` runs on the pool with no transaction open at all. `capacity.ts`'s own
module rule is "every query here takes the caller's `Transaction` handle, never `getDb()`" —
written for the locked, money-moving capacity checks, not for an unlocked public read. The fix
is the same `Database | Transaction` widening `vehiclePriceForRouteAndType` already uses
(default to the pool, accept a transaction when the caller — T10/`create-booking.ts` — has one
open), documented in `capacity.ts` as the one function in that module allowed the widening,
specifically because it is read-only and never participates in a capacity decision that needs
the lock. **This is the rule 1F's own acceptance test
("add MPV → price on one route → it appears for guests only on that route") actually exercises
— and it is vacuous against an empty fleet.** `rg_travel_test` keeps an EMPTY fleet by design
(CLAUDE.md, "Dispatch"), so a test that only adds a price row and checks visibility would pass
whether or not the sellability half of this rule is even implemented, because zero sellable
vehicles of every type already hides everything for the wrong reason. **The test must seed at
least one sellable van of the new type in-test** (a local fixture insert, torn down after,
exactly as other capacity tests that need a non-empty fleet already do) — this is called out
explicitly so 1F's implementer does not write a test that cannot fail.

---

## 5. Test plan (owned per-task, summarized here for the reviewer)

- **1A (schema) — corrected after advisor review of the test harness's own structure.**
  `global-setup.ts` migrates `rg_travel_test` to its FINAL shape before any test file loads, so
  a committed suite test literally cannot set up a "pre-migration shape, then migrate" scenario
  — there is no pre-migration state left to seed a fixture into by the time any test runs. The
  originally-claimed "backfill test covering both the zero-rows and seeded-rows case" is
  therefore not an automated suite test; it is a **one-off manual verification**, run once
  against a scratch copy of local `rg_travel` before 1A is reported done (apply migrations
  0015–0022 to a throwaway copy, insert a fixture destination + transfer_routes row by hand in
  the pre-0023 shape, apply 0023+, assert the place/route backfill landed correctly) — reported
  in the 1A write-up, not committed as a test file. **What IS a committed suite test:**
  post-migration invariants only — `vehicle_types`/`transfer_places` each get a
  create/duplicate-key(`name_key`)/soft-delete test mirroring `destinations`'s existing ones;
  the CHECK rewrite gets a raw-INSERT test proving the database itself still refuses a malformed
  row under the new `vehicle_type_id` column name (the exact mutation-proof §1.6 already
  requires); the PK-swap migration (§1.4) gets a test asserting the composite PK still refuses a
  second row for one `(route_id, vehicle_type_id)` pair.
- **1B (services):** `capacity.test.ts`'s existing two-type-literal scenarios re-proven under
  dynamic ids (same assertions, N-type-agnostic now); a new scenario with 3+ active vehicle
  types proves the generalization is real, not coincidentally correct for N=2; the "deactivated
  type with a standing booking still counted" case from §2 of this note, concurrency-proven the
  same way existing capacity tests are (two simultaneous holds, one slot, one wins). The
  van/suv-literal grep test, scoped per §2's closing paragraph.
- **1C (shared/tRPC):** role tests for the two new admin routers (owner-only, dispatcher
  denied — reusing `toursPricing`'s existing role-isolation pattern, not a new area). Zod
  round-trip tests for the changed input shapes.
- **1D/1E (UI):** no new tests beyond the usual guard suite (`no-red`, contrast, 360px/44px) —
  functional coverage is 1F's.
- **1F (regression):** every item in the batch prompt's own list, plus §1.8's pre-migration
  snapshot-shape parse test and §4's seeded-fleet visibility test.
- **1G (seed):** app-context-only test proving exactly 4 demo routes, MPV priced on Cebu City
  only, and nothing demo-related in `seedBase`'s output.

---

## 6. Open items — reviewed 2026-11-08 by the dedicated Opus reviewer

1. ~~The exact generated constraint/index names...~~ **Resolved.** Read from the real
   `0016_salty_skreet.sql`: `transfer_routes_destination_id_destinations_id_fk` /
   `transfer_routes_destination_id_unique`, and (newly surfaced by the same check)
   `transfer_route_vehicle_prices_route_id_transfer_routes_id_fk`, which turned out to be the
   PK's backing index too — see §1.4's corrected 9-step sequence.
2. ~~Whether `vehicle_types.default_seats`/`default_luggage` being nullable...~~ **Confirmed
   correct.** Reviewer's independent conclusion: these are prefill only, `vans.capacity`/
   `luggage_capacity` stay authoritative, and inventing a number for the two backfilled rows
   would be the worse choice.
3. ~~Confirm the new post-catalog-read airport/flight-fields check...~~ **Confirmed as the only
   possible placement**, with one correction: document it as an explicit exception to
   `assertBookableShape`'s "everything here runs pre-transaction" promise rather than letting
   that promise go stale, and give `reverse_not_enabled_for_route` the same treatment (both
   checks need the route resolved, which only exists inside the transaction).
4. **New, for the owner, not the reviewer — flag before 1B starts coding either rule:**
   (a) With `reverse_enabled` true on route (A→B), nothing in this design stops an admin from
   ALSO separately creating route (B→A) — the identical journey listed twice, possibly at
   different prices, since `UNIQUE(from_place_id, to_place_id)` treats them as different rows.
   Decide: refuse creating the reverse pair outright when a `reverse_enabled` route already
   covers it, or leave it as an admin-trusted judgment call (routes are owner-only, `toursPricing`)?
   (b) Is the new "flight fields required when either end of the route is an airport place"
   rule (§2 table, `create-booking.ts` row) actually wanted at launch? It refuses some one-way
   transfer requests that are bookable today (flight fields are currently always optional on a
   one-way trip) — confirm this is an intended tightening, not an unintended regression the
   design introduced while answering decision 5.

**Also resolved by this review and folded into the sections above, not merely listed here:**
the PK-drop ordering bug in §1.4 (would have failed migration 1A outright with ERROR 1553), the
capacity.ts key-set hole in §2 (would have accepted a hold against zero vehicles for an
edge-case type/sellability combination), the missing `vehicle_types.is_active` join on the
money path in `pricing.ts` (§2), the lost price-row completeness contract in `upsert-route.ts`
(§1.4), the missing `assign.ts`/`transfers-checkout.ts`/`checkout.ts`/client change sites (§2),
the `seed.ts:416` typecheck failure this plan would otherwise cause (§2), the `INSERT IGNORE`
fix for migration 0024 (§1.2), and the hand-written-migration-mechanics preamble (§0).

**APPROVED, as amended by this review, 2026-11-08. Proceeding to 1A.**
