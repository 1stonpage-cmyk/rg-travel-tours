import CatalogPreview from '@/components/home/CatalogPreview';
import HeroSection from '@/components/home/HeroSection';
import HowItWorks from '@/components/home/HowItWorks';
import MostVisited from '@/components/home/MostVisited';
import TrustBar from '@/components/home/TrustBar';
import WhyBookDirect from '@/components/home/WhyBookDirect';

export default function HomePage() {
  return (
    <>
      <HeroSection />
      <TrustBar />
      <CatalogPreview />
      <HowItWorks />
      <WhyBookDirect />
      <MostVisited />
      {/* Sections 7-11 are added in Task 8. */}
    </>
  );
}
