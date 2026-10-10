import CatalogPreview from '@/components/home/CatalogPreview';
import ContactSection from '@/components/home/ContactSection';
import FaqSection from '@/components/home/FaqSection';
import HeroSection from '@/components/home/HeroSection';
import HowItWorks from '@/components/home/HowItWorks';
import MostVisited from '@/components/home/MostVisited';
import PackagesSection from '@/components/home/PackagesSection';
import PromoNewsletter from '@/components/home/PromoNewsletter';
import ReviewsSection from '@/components/home/ReviewsSection';
import TrustBar from '@/components/home/TrustBar';
import WhyBookDirect from '@/components/home/WhyBookDirect';
import { useScrollReveal } from '@/lib/use-scroll-reveal';

/**
 * Every section below the hero fades in as it is scrolled to. Done from here
 * with one selector rather than wrapping eleven components, so the sections
 * stay plain markup. The hero is excluded — it animates on load instead.
 *
 * #tours, #packages and #reviews are also excluded (spec task 2.9C): each of
 * those owns a card grid that staggers its own cards in individually once they
 * mount from React Query, via useCardStagger inside CatalogPreview /
 * PackagesSection / ReviewsSection. Leaving them in this selector too would
 * fade the whole section in as one block *and* fade its cards in again
 * inside that block — a visible double animation.
 */
const REVEAL_SECTIONS =
  '#main > section:not(:first-child):not(#tours):not(#packages):not(#reviews)';

/**
 * Home sections in the order given by BUILD_SPEC.md section 4.
 * Sections 12 (footer) and 13 (floating WhatsApp) live in PublicLayout.
 */
export default function HomePage() {
  useScrollReveal(REVEAL_SECTIONS);

  return (
    <>
      <HeroSection />
      <TrustBar />
      <CatalogPreview />
      <HowItWorks />
      <WhyBookDirect />
      <MostVisited />
      <PackagesSection />
      <ReviewsSection />
      <PromoNewsletter />
      <FaqSection />
      <ContactSection />
    </>
  );
}
