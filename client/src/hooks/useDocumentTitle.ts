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
 * `null` means "leave the injected title alone", and for THIS hook it is the
 * right answer always: `useDocumentTitle` only ever carries a bare name
 * (`STATIC_PUBLIC_TITLES`, `APP_SURFACE_TITLES`) that it appends the brand
 * suffix to itself, so it has nothing useful to say about a route whose real
 * title is a different shape entirely.
 *
 * That used to include the home page and the two detail pages — their
 * titles come from `settings.site_seo` and a row's own `seo_title`/the
 * `tourTitle()`/`packageTitle()` fallback, and this hook cannot build either
 * without duplicating server logic, so it passed `null` and left the
 * server-injected title to go stale on a client-side navigation. Task 4
 * (1D) closed that gap, but NOT by teaching this hook those formulas: those
 * three pages now call {@link useRawDocumentTitle} themselves, with the
 * server's own already-complete string (`pageTitle` on `tours.bySlug` /
 * `packages.bySlug`, `siteSeo.title` on `settings.get`). This hook's `null`
 * contract for those routes is accordingly unchanged — `PublicLayout` still
 * has nothing to offer them and still says so by passing `null` — but it is
 * no longer the WHOLE story for those routes the way it reads below.
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

/**
 * Sets `document.title` to `title` VERBATIM — no ` | TravelSugbo` suffix —
 * whenever `title` changes. Pass `null` to leave the document's current
 * title untouched, exactly as {@link useDocumentTitle} does.
 *
 * For the handful of routes whose real title is already a complete,
 * fully-formed string by the time it leaves the server: the home page's
 * `settings.site_seo.title`, and a tour/package detail page's `tourTitle()` /
 * `packageTitle()` (`server/src/seo/resolvers.ts`) — both of which already
 * end in the brand name, or are an admin's own `seo_title` override with no
 * brand suffix implied at all. Passing either through {@link useDocumentTitle}
 * would append a second, redundant suffix.
 */
export function useRawDocumentTitle(title: string | null): void {
  useEffect(() => {
    if (title === null) return;
    document.title = title;
  }, [title]);
}
