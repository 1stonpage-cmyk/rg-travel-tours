# Transfer legal & content checklist — for the owner

What R&G Travel & Tours needs to supply before the transfer product launches with real
(non-placeholder) policy content. **This file lists what is needed and where it goes —
it does not draft any legal or policy text.** Writing the actual clause wording is a
legal-review task, not an engineering one; nothing here should be treated as that text.

Every item below is currently either a placeholder (shared with the existing tours
Terms/Refund Policy pages) or an open question with no owner answer yet. None of it
blocks the current batch of engineering work — it blocks clearing
`settings.content_unverified` for the transfer product specifically, the same gate
`docs/LAUNCH_CHECKLIST.md` already tracks for the tours side.

**Never invent a number, a policy, or an accreditation code to fill a gap below.**
Same rule as `docs/LAUNCH_CHECKLIST.md`'s "Permits and legal" section — an unverified
figure here is worse than an explicit "pending" state.

---

## 1. No-show / waiting-time policy

- **What's needed:** how long the driver waits at pickup (airport or hotel) before a
  booking counts as a no-show, and what happens next (forfeit, rebook, partial refund).
- **Where it surfaces:** Terms of Service page (`legal_terms` setting) — currently the
  same placeholder text tours use, with nothing transfer-specific.
- **Who decides:** owner / legal review.
- **Status:** open, placeholder only.

## 2. Flight-delay handling

- **What's needed:** whether (and how) a delayed inbound flight is accommodated — does
  the driver's wait clock start from actual landing time, is there a grace period, does
  a long delay become a no-show under item 1's policy.
- **Where it surfaces:** Terms of Service page, same placeholder as item 1. The product
  already captures `flightNumber`/`airline` on a booking (`booking_transfer_details`),
  so the data needed to act on this policy exists even though the policy itself doesn't
  yet.
- **Who decides:** owner / legal review.
- **Status:** open, placeholder only.

## 3. Luggage limits, oversize bags, and per-vehicle capacity

- **What's needed:** confirmation that the enforcement model is correct as built — a
  vehicle type's `defaultLuggage` capacity is checked at hold time, and a booking whose
  party exceeds it is simply refused that vehicle type rather than accepted with
  luggage "forfeited" or surcharged. If R&G wants an oversize-item surcharge or a
  separate large-luggage category instead, that is a feature change, not a content
  change — flag it rather than writing copy for a mechanism that doesn't exist.
- **Where it surfaces:** vehicle selection step of `/transfer` (capacity is enforced,
  not merely described); any supporting copy would go on the Terms page or inline on
  that step.
- **Who decides:** owner (confirms enforcement model) / legal review (any copy).
- **Status:** mechanism built and enforced; no legal copy needed beyond confirming the
  above is the intended behaviour.

## 4. Child seats and children travelling on an adult's lap

- **What's needed:** does R&G provide child seats (on request, free, surcharged), and
  is a child permitted on an adult's lap instead of an occupying a seat for capacity
  purposes. This affects how `pax`/seat-capacity counts should be explained to a guest,
  if at all.
- **Where it surfaces:** Terms of Service page, and potentially the "Special requests"
  field's placeholder copy on the booking form (`TransferGuestDetailsForm.tsx`).
- **Who decides:** owner / legal review.
- **Status:** open — not referenced anywhere in the current build.

## 5. Day-use overrun (vehicle hired for the day, trip runs long)

- **What's needed:** what happens when a day-use booking's actual usage runs past the
  booked `dayUseEndTime` — is there a per-hour overrun charge, a hard cutoff, or is it
  handled case-by-case by dispatch. No default exists anywhere in the 2026-10-31 plan's
  owner answers.
- **Where it surfaces:** Terms of Service page; `dayUseEndTime` is already captured on
  the booking (`booking_transfer_details`) and shown to the driver/office, so the data
  needed to detect an overrun exists even though no policy or charge mechanism does.
- **Who decides:** owner — this is still genuinely open, flagged in the original plan
  and not resolved since.
- **Status:** open, no placeholder yet (not covered by the generic tours Refund
  Policy the way items 1–2 are).

## 6. Ferry fees, entrance fees, and other costs not included in the transfer price

- **What's needed:** a plain statement of what the quoted transfer price does and does
  not cover — e.g. a Hagnaya Port transfer gets a guest to the port, not onto the ferry;
  a destination with an entrance fee (park, beach, falls) is the guest's own cost on
  top of the ride.
- **Where it surfaces:** each transfer route already has an admin-editable
  `inclusionsText` / `exclusionsText` pair (`AdminTransferRoutesPage.tsx`), rendered on
  the guest-facing route picker — so this is "write the text into the field that
  exists," not a feature gap. Today those fields are empty for the seeded demo routes.
- **Who decides:** owner, per route (ferry fees only apply to port-adjacent routes;
  entrance fees only apply to destination-specific routes).
- **Status:** field exists and is wired end to end; content not yet entered for any
  route.

## 7. Cancellation / refund window for transfers

- **What's needed:** confirmation that reusing the existing tours Refund Policy
  placeholder is acceptable for transfers too (owner answer 8, 2026-10-31), and the
  actual free-cancellation window R&G wants per route.
- **Where it surfaces:** Refund Policy page (shared placeholder with tours);
  `transfer_routes.free_cancel_hours` is the enforced number, admin-editable per route,
  already defaulted to 24 hours (same default tours use) so nothing is unenforced in
  the meantime.
- **Who decides:** owner confirms the default (24h) is right per route, or supplies a
  different number per route via the admin Transfer Routes screen.
- **Status:** enforced with a sensible default; the default itself hasn't been
  explicitly owner-confirmed as final.

## 8. "Operated by R&G Travel & Tours" — regulatory / accreditation language

- **What's needed:** confirmation of whether transfer services fall under the same
  DOT/DTI/BIR accreditation already shown for tours, or whether transfers (as
  point-to-point vehicle hire) fall under separate LTFRB or other transport-specific
  requirements that need their own permit numbers and their own copy.
- **Where it surfaces:** site footer's "Operated by" / accreditation block
  (`client/src/lib/site.ts`'s `SITE.legalOperator`), currently showing the tours
  DOT/DTI/BIR numbers as "— pending —" since none have been supplied yet (same
  `null`-renders-pending behaviour that already exists — see
  `docs/LAUNCH_CHECKLIST.md`'s "Permits and legal" section).
- **Who decides:** owner, after checking with DOT/LTFRB on whether a transport permit
  distinct from the tour-operator accreditation applies.
- **Status:** open — this question predates the transfer product's launch batch and is
  still unanswered.

---

## Summary table

| #   | Item                                 | Placeholder today?     | Blocking?                            |
| --- | ------------------------------------ | ---------------------- | ------------------------------------ |
| 1   | No-show / waiting-time policy        | Yes (shared, generic)  | Content only                         |
| 2   | Flight-delay handling                | Yes (shared, generic)  | Content only                         |
| 3   | Luggage limits / oversize            | N/A — enforced in code | Confirm model, not content           |
| 4   | Child seats / children on laps       | No                     | Content only                         |
| 5   | Day-use overrun                      | No                     | Owner decision + content             |
| 6   | Ferry / entrance fees not included   | No (field empty)       | Content only, field already exists   |
| 7   | Cancellation window for transfers    | Yes (shared default)   | Confirm default, content optional    |
| 8   | "Operated by" accreditation language | Yes ("— pending —")    | Owner research + real permit numbers |

None of these block engineering work already completed in this batch. They block
clearing `settings.content_unverified` for a real transfer-product launch, the same
gate that already governs the tours side.
