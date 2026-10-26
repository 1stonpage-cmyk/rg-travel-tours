import {
  CONSENT_MAX_AGE_MS,
  CONSENT_STORAGE_KEY,
  CONSENT_VERSION,
  type ConsentCategories,
  type StoredConsent,
} from './types';

function isStoredConsent(value: unknown): value is StoredConsent {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.v === 'number' &&
    typeof v.analytics === 'boolean' &&
    typeof v.marketing === 'boolean' &&
    typeof v.at === 'string'
  );
}

/**
 * Reads the stored choice, treating it as unset (returns null) when: nothing is stored, the
 * value doesn't parse, its version is behind `CONSENT_VERSION` (a category set changed — spec
 * point 5), or it is older than 12 months. localStorage access is wrapped in try/catch: a private
 * window or storage-disabled browser degrades to "always ask" rather than throwing.
 */
export function readStoredConsent(now: Date = new Date()): StoredConsent | null {
  try {
    const raw = localStorage.getItem(CONSENT_STORAGE_KEY);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    if (!isStoredConsent(parsed)) return null;
    if (parsed.v !== CONSENT_VERSION) return null;
    const age = now.getTime() - new Date(parsed.at).getTime();
    if (!Number.isFinite(age) || age > CONSENT_MAX_AGE_MS) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function writeStoredConsent(categories: ConsentCategories, now: Date = new Date()): void {
  const value: StoredConsent = {
    v: CONSENT_VERSION,
    analytics: categories.analytics,
    marketing: categories.marketing,
    at: now.toISOString(),
  };
  try {
    localStorage.setItem(CONSENT_STORAGE_KEY, JSON.stringify(value));
  } catch {
    // Private window or storage disabled: the choice simply won't persist across reloads —
    // not a reason to crash the page over a cookie banner.
  }
}
