/**
 * Keeps `document.title` honest after a client-side navigation.
 *
 * ## The gap this closes
 *
 * Per-route head content is injected SERVER-side, from the database, for
 * every public route and the three app surfaces (CLAUDE.md, "SEO &
 * indexing"). That is right for crawlers and right for a cold load — but it
 * happens once, for the path the SPA was first loaded at, and React Router
 * never asks for another document. So a driver who signed in at
 * `/driver/login` read "Driver portal" for a whole shift no matter which
 * screen they were on (which is correct, by luck, for that surface) and a
 * guest who clicked from `/privacy` to `/terms` kept reading "Privacy
 * Notice" (which is not).
 *
 * ## Why it takes a nullable title
 *
 * `null` means "leave the injected title alone", and it is the right answer
 * more often than it looks. The home page's title comes from
 * `settings.site_seo` and a tour or package detail title from that row's own
 * `seo_title`; the browser has no access to either, so inventing a
 * client-side substitute would replace a correct database-driven title with
 * a worse guess. Passing `null` preserves exactly today's behaviour for
 * those routes rather than regressing them.
 *
 * ## It writes nothing but the title
 *
 * No description, no canonical, no Open Graph, no JSON-LD. Those are read by
 * crawlers, which never run this code, and `seo/render.ts` is their single
 * escaping boundary. The words themselves come from `@rg/shared`
 * (`APP_SURFACE_TITLES`, `STATIC_PUBLIC_TITLES`), which the server's
 * resolver reads too — so this is a second READER of one source, not a
 * second source.
 */
import { useEffect } from 'react';
import { SITE } from '@/lib/site';

/** The suffix every injected title carries, appended here rather than at each call site. */
export function brandedTitle(name: string): string {
  return `${name} | ${SITE.name}`;
}

/**
 * Sets `document.title` to `name | TravelSugbo` whenever `name` changes.
 *
 * Pass `null` to leave the document's current title untouched — including
 * the one the server injected on the cold load.
 *
 * Nothing is restored on unmount: the next route's own call is what replaces
 * the title, and a cleanup that put the old one back would flash the
 * previous page's name between two screens.
 */
export function useDocumentTitle(name: string | null): void {
  useEffect(() => {
    if (name === null) return;
    document.title = brandedTitle(name);
  }, [name]);
}
