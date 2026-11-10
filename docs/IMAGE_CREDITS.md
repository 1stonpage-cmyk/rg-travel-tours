# Image credits — transfer vehicle photos

Owner decision 2026-11-10 (see `HANDOVER-18`): the guest-facing vehicle-type cards on
`/transfer` show free, legally-licensed stock photos until R&G supplies its own fleet
photography. All four photos below were sourced from Unsplash or Pexels only, verified
free-license on each photo's own page, and checked for visible plates, company logos,
identifiable faces and watermarks before download. Every vehicle is generic — it must
not be mistaken for a specific operator's own fleet, which is also why each card carries
a visible "Sample vehicle" caption on the site.

None of these photos were taken in Cebu or the Philippines. They are illustrative only
and are never captioned as a specific place.

## vehicle-van

- **Files:** `client/public/images/transfers/van-original.jpg` (source copy, not served),
  `van-480.jpg`, `van-800.jpg` (served, via `srcset`)
- **Source:** Pexels
- **Photo page:** https://www.pexels.com/photo/white-minivan-parked-at-modern-airport-terminal-39075475/
- **Photographer:** Yazid N
- **Photographer profile:** https://www.pexels.com/@mzynasx/
- **Licence:** Pexels License ("Free to use" — confirmed on the photo's own page)
- **Date checked:** 2026-11-10
- **Note:** Side view of a white Toyota HiAce–style passenger van (windowed, not cargo)
  at an airport drop-off. No plate visible on the van itself (front angled away from
  camera); the small Toyota badge on the grille is incidental, not prominent. No
  identifiable faces (passengers, if any, are unidentifiable silhouettes behind tinted
  glass). No company livery or watermark. A second vehicle in the background has its own
  plate visible, but it is not the photographed subject and is not R&G's.

## vehicle-suv

- **Files:** `client/public/images/transfers/suv-original.jpg`, `suv-480.jpg`, `suv-800.jpg`
- **Source:** Unsplash
- **Photo page:** https://unsplash.com/photos/a-white-suv-and-another-car-parked-near-a-building-lIu4896gsHg
- **Photographer:** Kern Morris
- **Photographer profile:** https://unsplash.com/@kernsway
- **Licence:** Unsplash License ("Free to use under the Unsplash License" — confirmed on
  the photo's own page)
- **Date checked:** 2026-11-10
- **Note:** Side view of a white crossover SUV (Honda HR-V/Vezel) in a parking lot. No
  plate visible from this angle, no prominent badge/logo, no people, no watermark.

## vehicle-mpv

- **Files:** `client/public/images/transfers/mpv-original.jpg`, `mpv-480.jpg`, `mpv-800.jpg`
- **Source:** Pexels
- **Photo page:** https://www.pexels.com/photo/sleek-modern-minivan-driving-on-scenic-road-30195580/
- **Photographer:** Jeremy Li
- **Photographer profile:** https://www.pexels.com/@picswithjer/
- **Licence:** Pexels License ("Free to use" — confirmed on the photo's own page)
- **Date checked:** 2026-11-10
- **Note:** Side view of a grey people-carrier minivan (Chrysler Pacifica) in motion on a
  rural highway. No plate visible (side angle, vehicle in motion), only a small incidental
  badge on the grille. A driver is present but is an unidentifiable motion-blurred
  silhouette, not the subject. No company livery or watermark.

## vehicle-generic (fallback for any vehicle type with no photo of its own)

- **Files:** `client/public/images/transfers/generic-original.jpg`, `generic-480.jpg`,
  `generic-800.jpg`
- **Source:** Pexels
- **Photo page:** https://www.pexels.com/photo/white-car-on-a-road-21821470/
- **Photographer:** Mehrajul Karim
- **Photographer profile:** https://www.pexels.com/@mehrajul-karim-114876029/
- **Licence:** Pexels License ("Free to use" — confirmed on the photo's own page)
- **Date checked:** 2026-11-10
- **Note:** Rear three-quarter view of a white sedan (Honda Civic) in motion on an
  elevated road. No plate visible, no badge/logo visible at this angle, no people, no
  watermark. Chosen as the generic/neutral fallback because it reads as "a car", distinct
  from the van/SUV/MPV photos above, for any future vehicle type the admin adds before a
  real photo exists for it.

## What still needs R&G's own photography

All four images above are temporary. They should be replaced with real photos of R&G's
actual fleet as soon as the owner supplies them — see `HANDOVER-18` for the wiring
(`client/src/lib/transfer-images.ts`) that makes that a drop-in file swap, no code change
needed, as long as the replacement keeps the same file names.
