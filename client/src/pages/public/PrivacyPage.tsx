import LegalPage from '@/components/common/LegalPage';
import { privacyContent } from '@/content/legal/privacy';

/**
 * Task 2B (2026-10-27) — static content from the owner-approved draft, replacing the
 * settings-driven version Task 3.6 built. See docs/superpowers/plans/2026-10-27-legal-pages.md
 * for why.
 */
export default function PrivacyPage() {
  return <LegalPage content={privacyContent} />;
}
