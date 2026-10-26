import LegalPage from '@/components/common/LegalPage';
import { refundPolicyContent } from '@/content/legal/refundPolicy';

/** Task 2B (2026-10-27) — new page, static content from the owner-approved draft. */
export default function RefundPolicyPage() {
  return <LegalPage content={refundPolicyContent} />;
}
