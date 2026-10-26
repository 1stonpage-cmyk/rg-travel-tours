import LegalPage from '@/components/common/LegalPage';
import { cookiesContent } from '@/content/legal/cookies';

/** Task 2B (2026-10-27) — new page, static content from the owner-approved draft. */
export default function CookiesPage() {
  return <LegalPage content={cookiesContent} />;
}
