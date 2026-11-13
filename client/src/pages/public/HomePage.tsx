import CatalogPreview from '@/components/home/CatalogPreview';
import ContactSection from '@/components/home/ContactSection';
import FaqSection from '@/components/home/FaqSection';
import HeroSection from '@/components/home/HeroSection';
import HowItWorks from '@/components/home/HowItWorks';
import MostVisited from '@/components/home/MostVisited';
import PackagesSection from '@/components/home/PackagesSection';
import PopularTransfers from '@/components/home/PopularTransfers';
import PromoNewsletter from '@/components/home/PromoNewsletter';
import ReviewsSection from '@/components/home/ReviewsSection';
import TrustBar from '@/components/home/TrustBar';
import WhyBookDirect from '@/components/home/WhyBookDirect';
import { useRawDocumentTitle } from '@/hooks/useDocumentTitle';
import { trpc } from '@/lib/trpc';
import { useScrollReveal } from '@/lib/use-scroll-reveal';

/**
 * Every section below the hero fades in as it is scrolled to. Done from here
 * with one selector rather than wrapping eleven components, so the sections
 * stay plain markup. The hero is excluded — it animates on load instead.
 *
 * #tours, #packages, #reviews and #popular-transfers are also excluded (spec
 * task 2.9C, extended by Task 7 / 1D): each of those owns a card grid that
 * staggers its own cards in individually once they mount from React Query,
 * via useCardStagger inside CatalogPreview / PackagesSection /
 * ReviewsSection / PopularTransfers. Leaving them in this selector too would
 * fade the whole section in as one block *and* fade its cards in again
 * inside that block — a visible double animation.
 */
const REVEAL_SECTIONS =
  '#main > section:not(:first-child):not(#tours):not(#packages):not(#reviews):not(#popular-transfers)';

/**
 * Home sections in the order given by BUILD_SPEC.md section 4.
 * Sections 12 (footer) and 13 (floating WhatsApp) live in PublicLayout.
 */
export default function HomePage() {
  useScrollReveal(REVEAL_SECTIONS);

  /*
   * `show_tours` gate (transfers-launch plan, Task T16). CatalogPreview and
   * MostVisited are not mounted at all while tours are hidden, rather than
   * mounting and letting `tours.list` resolve to an empty "Tours" heading
   * (CatalogPreview) or a destination grid whose only links lead into that
   * hidden catalog (MostVisited) — both a worse experience than no section.
   * Defaults to hidden before `settings.get` resolves, same as every other
   * gate this task adds: the product default is tours off, so there is
   * nothing to flash on while loading.
   *
   * Decision 2 (2026-11-10) extends this to `PackagesSection`: packages are
   * hidden the same way, for the same reason — a mounted section whose only
   * links lead into a hidden product line is worse than no section.
   */
  const { data: settings } = trpc.settings.get.useQuery();
  const showTours = settings?.showTours ?? false;
  /*
   * Task 4 (1D): `settings.site_seo.title` is already a complete string
   * (e.g. "TravelSugbo — Cebu Airport & Island Transfers") — the server
   * injects it verbatim on a cold load, so this re-asserts the same string
   * on a client-side navigation INTO `/`, with no brand suffix appended.
   * `null` until `settings.get` resolves, which leaves whatever title is
   * already showing untouched.
   */
  useRawDocumentTitle(settings?.siteSeo?.title ?? null);

  return (
    <>
      <HeroSection />
      <TrustBar />
      {showTours && <CatalogPreview />}
      <HowItWorks />
      <PopularTransfers />
      <WhyBookDirect />
      {showTours && <MostVisited />}
      {showTours && <PackagesSection />}
      <ReviewsSection />
      <PromoNewsletter />
      <FaqSection />
      <ContactSection />
    </>
  );
}
