import { MessageCircle } from 'lucide-react';
import { SITE, whatsappLink } from '@/lib/site';

export default function FloatingWhatsApp() {
  return (
    <a
      href={whatsappLink(`Hi ${SITE.name}! I'd like to ask about a Cebu tour.`)}
      target="_blank"
      rel="noreferrer noopener"
      aria-label="Chat with us on WhatsApp"
      className="bg-brand-blue-600 hover:bg-brand-blue-700 focus-visible:ring-brand-gold-400 fixed bottom-4 right-4 z-50 flex min-h-14 min-w-14 items-center justify-center gap-2 rounded-full px-4 text-white shadow-lg transition-transform hover:scale-105 sm:bottom-6 sm:right-6"
    >
      <MessageCircle className="size-6" aria-hidden="true" />
      <span className="hidden text-sm font-semibold sm:inline">WhatsApp</span>
    </a>
  );
}
