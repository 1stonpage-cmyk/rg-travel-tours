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

/**
 * Home sections in the order given by BUILD_SPEC.md section 4.
 * Sections 12 (footer) and 13 (floating WhatsApp) live in PublicLayout.
 */
export default function HomePage() {
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
