/**
 * Task 1D ("Real photos for transfers from free, legal stock", owner
 * decision 2026-11-10). Not required by the Unsplash/Pexels licences — both
 * permit use with no attribution — but good practice, and a place to point
 * at if a photographer ever asks where their photo is used.
 *
 * The four entries below mirror `docs/IMAGE_CREDITS.md` by hand: that file
 * is the authoritative record checked during sourcing (licence, no-plates/
 * logos/faces note, date checked); this page is the guest-facing summary of
 * it. Update both together if a photo is ever swapped.
 */
const CREDITS = [
  {
    slug: 'vehicle-van',
    description: 'Sample van photo (vehicle type card)',
    photographer: 'Yazid N',
    profileHref: 'https://www.pexels.com/@mzynasx/',
    photoHref:
      'https://www.pexels.com/photo/white-minivan-parked-at-modern-airport-terminal-39075475/',
    source: 'Pexels',
    licence: 'Pexels License',
  },
  {
    slug: 'vehicle-suv',
    description: 'Sample SUV photo (vehicle type card)',
    photographer: 'Kern Morris',
    profileHref: 'https://unsplash.com/@kernsway',
    photoHref:
      'https://unsplash.com/photos/a-white-suv-and-another-car-parked-near-a-building-lIu4896gsHg',
    source: 'Unsplash',
    licence: 'Unsplash License',
  },
  {
    slug: 'vehicle-mpv',
    description: 'Sample MPV photo (vehicle type card)',
    photographer: 'Jeremy Li',
    profileHref: 'https://www.pexels.com/@picswithjer/',
    photoHref: 'https://www.pexels.com/photo/sleek-modern-minivan-driving-on-scenic-road-30195580/',
    source: 'Pexels',
    licence: 'Pexels License',
  },
  {
    slug: 'vehicle-generic',
    description: 'Sample vehicle photo (fallback for a vehicle type with no photo of its own)',
    photographer: 'Mehrajul Karim',
    profileHref: 'https://www.pexels.com/@mehrajul-karim-114876029/',
    photoHref: 'https://www.pexels.com/photo/white-car-on-a-road-21821470/',
    source: 'Pexels',
    licence: 'Pexels License',
  },
] as const;

export default function PhotoCreditsPage() {
  return (
    <article className="mx-auto w-full max-w-[65ch] px-4 py-12 text-base leading-relaxed sm:px-6">
      <h1 className="text-brand-blue-900 text-3xl font-bold tracking-tight">Photo credits</h1>
      <p className="text-muted-foreground mt-3 text-sm">
        The vehicle photos on our transfer booking page are free stock photography, used while we
        gather our own fleet photos. Every vehicle shown is a sample for illustration only — it is
        not a specific vehicle from our own fleet. Crediting photographers isn't required by the
        free licences we used, but we think it's the right thing to do.
      </p>

      <ul className="mt-8 space-y-6">
        {CREDITS.map((credit) => (
          <li key={credit.slug} className="border-border border-t pt-6 first:border-t-0 first:pt-0">
            <p className="text-brand-blue-900 font-semibold">{credit.description}</p>
            <p className="text-muted-foreground mt-1 text-sm">
              Photo by{' '}
              <a
                href={credit.profileHref}
                target="_blank"
                rel="noopener noreferrer"
                className="text-brand-blue-700 hover:underline"
              >
                {credit.photographer}
              </a>{' '}
              on{' '}
              <a
                href={credit.photoHref}
                target="_blank"
                rel="noopener noreferrer"
                className="text-brand-blue-700 hover:underline"
              >
                {credit.source}
              </a>
              , used under the {credit.licence}.
            </p>
          </li>
        ))}
      </ul>
    </article>
  );
}
