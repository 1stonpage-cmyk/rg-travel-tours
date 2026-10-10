import { useEffect, useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { WhatsAppGlyph } from '@/components/common/BrandGlyphs';
import { Button } from '@/components/ui/button';
import { SITE, whatsappLink } from '@/lib/site';
import { trpc } from '@/lib/trpc';
import { cn } from '@/lib/utils';

/**
 * The hero's search form is the page's primary CTA. A fixed bottom-right (or
 * bottom, full-width) control otherwise sweeps across it as the page scrolls
 * — measured at 360px and 390px, where it covered ~40px of the "Search
 * tours" button (and at 390px it did so at first paint, before any
 * scrolling).
 *
 * Raising the offset or padding the page does not fix that: a fixed element
 * still passes over everything on the way down. So both the desktop bubble
 * and the mobile bottom bar below hide while the search form is on screen
 * and return once it scrolls away. Scoped deliberately to the hero form
 * rather than the whole hero section, so the controls come back as soon as
 * the CTA they were covering is gone. Pages without that form (e.g. /tours)
 * are unaffected — both show throughout.
 */
const HERO_SEARCH_FORM = 'form[aria-label="Search tours"]';

/**
 * The bottom bar additionally hides once the footer starts to arrive (spec
 * task 2.9B: "hides near the footer"), so a full-width strip never sits on
 * top of the footer's own content. There is exactly one <footer> per page
 * (SiteFooter, rendered by PublicLayout), so a plain tag selector is enough.
 */
const FOOTER_SELECTOR = 'footer';

/**
 * The attention pulse (and the label peek that follows it) must fire once
 * per session, not once per mount. FloatingWhatsApp normally only mounts
 * once — PublicLayout renders it outside <Outlet>, so it survives
 * client-side route changes — but a plain React ref/state would still replay
 * on a full page reload within the same tab. sessionStorage survives that;
 * a new tab or browser restart gets a fresh session and the pulse again.
 */
const PULSE_SESSION_KEY = 'ts-whatsapp-pulse-shown';

function pulseAlreadyShown(): boolean {
  try {
    return sessionStorage.getItem(PULSE_SESSION_KEY) === '1';
  } catch {
    // Privacy mode or storage disabled: degrade to "eligible" rather than
    // throwing. Worst case the pulse replays on a future load — a minor
    // cosmetic miss, not a broken page.
    return false;
  }
}

function markPulseShown() {
  try {
    sessionStorage.setItem(PULSE_SESSION_KEY, '1');
  } catch {
    // Same degrade as above.
  }
}

/**
 * True while the hero's search form is intersecting the viewport. Computed
 * once here and shared by both the desktop bubble and the mobile bottom bar
 * below (both read the same boolean from the same render) rather than each
 * standing up its own IntersectionObserver against the same element — one
 * fewer observer, and one piece of state instead of two that could
 * disagree about which render they flip on.
 */
function useCoversHeroSearch(pathname: string): boolean {
  const [covers, setCovers] = useState(false);

  useEffect(() => {
    // jsdom has no IntersectionObserver; degrade to always-visible rather
    // than throwing. Real behaviour is verified in a browser.
    if (typeof IntersectionObserver === 'undefined') return;

    const target = document.querySelector(HERO_SEARCH_FORM);
    if (!target) {
      setCovers(false);
      return;
    }

    const observer = new IntersectionObserver(([entry]) =>
      setCovers(entry?.isIntersecting ?? false),
    );
    observer.observe(target);
    return () => observer.disconnect();
  }, [pathname]);

  return covers;
}

/**
 * True once the footer has started to arrive — the mobile bottom bar's cue
 * to slide away. The positive bottom rootMargin extends the trigger zone
 * 120px below the real viewport edge, so this fires a little before the
 * footer is actually visible, giving the bar time to finish sliding out
 * before it would otherwise overlap it.
 */
function useNearFooter(pathname: string): boolean {
  const [near, setNear] = useState(false);

  useEffect(() => {
    if (typeof IntersectionObserver === 'undefined') return;

    const target = document.querySelector(FOOTER_SELECTOR);
    if (!target) {
      setNear(false);
      return;
    }

    const observer = new IntersectionObserver(
      ([entry]) => setNear(entry?.isIntersecting ?? false),
      { rootMargin: '0px 0px 120px 0px' },
    );
    observer.observe(target);
    return () => observer.disconnect();
  }, [pathname]);

  return near;
}

/**
 * "Chat with us" — sits beside the green pill, never inside it (spec task
 * 2.9I: white text on #25D366 measures 1.98:1 and fails AA at any size, so
 * the label lives on the page background in brand ink instead). Absolutely
 * positioned against the icon link's own box rather than a flex sibling, so
 * it never affects that box's position or reserves layout space — it simply
 * overlaps the page to the icon's left, invisible until revealed.
 *
 * `reveal` drives the one-shot mobile peek (label-peek, timed to start the
 * instant the attention pulse ends); the desktop hover reveal underneath it
 * is plain CSS (`group-hover`) and needs no JS at all.
 */
function ChatLabel({ reveal, onRevealEnd }: { reveal: boolean; onRevealEnd: () => void }) {
  return (
    <span
      aria-hidden="true"
      onAnimationEnd={onRevealEnd}
      className={cn(
        'text-brand-ink bg-background pointer-events-none absolute right-full top-1/2 mr-2 -translate-y-1/2 translate-x-2 whitespace-nowrap rounded-full px-3 py-1.5 text-sm font-semibold opacity-0 shadow-md transition-[opacity,transform] duration-200 ease-[cubic-bezier(0.2,0.6,0.2,1)] group-hover:translate-x-0 group-hover:opacity-100',
        reveal && 'label-peek',
      )}
    >
      Chat with us
    </span>
  );
}

export default function FloatingWhatsApp() {
  const { pathname } = useLocation();
  const coversHeroSearch = useCoversHeroSearch(pathname);
  const nearFooter = useNearFooter(pathname);
  const barVisible = !coversHeroSearch && !nearFooter;

  /**
   * `settings.openState.message` is computed server-side, in Asia/Manila
   * (Task 1.5's `resolveOpenState`) — rendered verbatim, never recomputed
   * from a client clock, which would show the Manila-correct message only
   * to a guest already in that timezone. Read via the same
   * `trpc.settings.get.useQuery()` call ContactSection makes: TanStack
   * Query dedupes identical queries by key, so both components resolve
   * from the one cached result rather than two independent reads that
   * could disagree. Rendered `sr-only` rather than as new visible copy —
   * the plan's global constraint for this phase is "no design change,
   * only the data source changes," and this control's accessible name
   * ("Chat with us on WhatsApp") and icon-only, text-free appearance are
   * both pinned by existing tests (layout.test.tsx, motion.test.tsx).
   */
  const { data: settings } = trpc.settings.get.useQuery();
  const openState = settings?.openState ?? null;

  // Computed once at mount (not re-read on every render) so a mid-session
  // sessionStorage write from this same component doesn't retroactively
  // change what it decided at mount.
  const [pulseEligible] = useState(() => !pulseAlreadyShown());
  const [pulse, setPulse] = useState(pulseEligible);
  const [peek, setPeek] = useState(pulseEligible);

  /*
   * Driven by animationend, not a timer, so the pulse is spent only if it
   * actually played — sitting on the hero for a minute doesn't burn it, and
   * leaving before it finishes re-arms it for when the button comes back
   * (within the session; see PULSE_SESSION_KEY above for the across-reload
   * guarantee). Shared between the desktop bubble and the bottom bar's own
   * icon below: only whichever one is actually visible at the current
   * breakpoint ever animates and fires this, the other's identical class
   * sits dormant.
   */
  const endPulse = () => {
    setPulse(false);
    markPulseShown();
  };
  const endPeek = () => setPeek(false);

  const message = `Hi ${SITE.name}! I'd like to ask about a Cebu tour.`;

  return (
    <>
      {/*
       * One sr-only node, not one per breakpoint variant below — both the
       * desktop bubble and the mobile bar exist in the DOM at once in this
       * project's "both mounted, CSS picks one" pattern, and duplicating
       * the same announcement per variant would just be noise for a screen
       * reader user. Omitted entirely while the query is still pending,
       * rather than rendering a stale/empty message.
       */}
      {openState && <span className="sr-only">{openState.message}</span>}
      {/*
       * Desktop (md and up): the floating bubble. Official WhatsApp green
       * instead of brand blue, icon-only with an aria-label instead of the
       * lucide icon + inline "WhatsApp" text it used to carry (spec task
       * 2.9I) — the label now lives in ChatLabel, revealed on hover.
       *
       * Hidden outright (returns null) rather than CSS-hidden while the
       * hero search form is on screen, exactly as before: a CSS-hidden
       * element would still sit there capturing hover/focus/taps over the
       * CTA it exists to avoid covering.
       */}
      {!coversHeroSearch && (
        <div className="motion-rise group fixed bottom-4 right-4 z-50 hidden sm:bottom-6 sm:right-6 md:block">
          <ChatLabel reveal={false} onRevealEnd={() => {}} />
          <a
            href={whatsappLink(message)}
            target="_blank"
            rel="noreferrer noopener"
            aria-label="Chat with us on WhatsApp"
            className={cn(
              'press-brand bg-whatsapp hover:bg-whatsapp-pressed focus-visible:ring-brand-gold-400 flex min-h-14 min-w-14 items-center justify-center rounded-full text-white shadow-lg transition-[transform,box-shadow,background-color] duration-200 hover:-translate-y-0.5 hover:shadow-xl',
              pulse && 'attention-pulse',
            )}
            onAnimationEnd={endPulse}
          >
            <WhatsAppGlyph className="size-6" />
          </a>
        </div>
      )}

      {/*
       * Mobile (<768px): a sticky bottom bar — "Book a tour" plus the same
       * WhatsApp control, replacing the bubble above rather than stacking a
       * second one on top of it (explicitly allowed, spec task 2.9B).
       *
       * Always mounted — never conditionally rendered to null — so hiding
       * it is a transform/opacity transition (the slide), not a mount/
       * unmount flash, and so it still appears, instantly, under reduced
       * motion rather than staying permanently hidden (the global
       * prefers-reduced-motion rule in index.css clamps the transition
       * duration to ~0, it never removes the end state).
       *
       * `inert` + `aria-hidden` when not visible: `opacity-0`/
       * `translate-y-full` hide the bar visually, but neither removes it
       * from the accessibility tree or the tab order — without these, a
       * keyboard or screen-reader user could still reach the "Book a tour"
       * button and the WhatsApp link while they sit slid off-screen over
       * whatever the hero covers, which is exactly the collision this
       * component exists to prevent. `inert` is the real mechanism (blocks
       * focus and pointer interaction in a browser); `aria-hidden` is
       * belt-and-braces for the accessibility-tree exclusion specifically.
       */}
      <div
        inert={!barVisible}
        aria-hidden={!barVisible}
        className={cn(
          'bg-background/95 fixed inset-x-0 bottom-0 z-50 flex items-center gap-3 border-t p-3 shadow-[0_-4px_12px_-4px_rgba(15,23,46,0.18)] backdrop-blur transition-[transform,opacity] duration-300 ease-[cubic-bezier(0.2,0.6,0.2,1)] md:hidden',
          barVisible
            ? 'translate-y-0 opacity-100'
            : 'pointer-events-none translate-y-full opacity-0',
        )}
        style={{ paddingBottom: 'max(0.75rem, env(safe-area-inset-bottom))' }}
      >
        <Button asChild size="lg" className="tap-target flex-1">
          <Link to="/tours">Book a tour</Link>
        </Button>

        <div className="group relative flex items-center">
          <ChatLabel reveal={peek} onRevealEnd={endPeek} />
          <a
            href={whatsappLink(message)}
            target="_blank"
            rel="noreferrer noopener"
            aria-label="Chat with us on WhatsApp"
            className={cn(
              'press-brand tap-target bg-whatsapp hover:bg-whatsapp-pressed focus-visible:ring-brand-gold-400 flex min-h-14 min-w-14 items-center justify-center rounded-full text-white shadow-md transition-[transform,box-shadow,background-color] duration-200',
              pulse && 'attention-pulse',
            )}
            onAnimationEnd={endPulse}
          >
            <WhatsAppGlyph className="size-6" />
          </a>
        </div>
      </div>
    </>
  );
}
