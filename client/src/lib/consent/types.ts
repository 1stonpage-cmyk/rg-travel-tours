/**
 * Cookie consent (task 2D, 05-cookie-consent-spec.md). Essential cookies are always on and carry
 * no toggle — only the two opt-in categories are tracked here.
 */
export type ConsentCategories = {
  analytics: boolean;
  marketing: boolean;
};

/** The stored shape, per the spec's own example: `{v, analytics, marketing, at}`. */
export type StoredConsent = ConsentCategories & {
  v: number;
  /** ISO timestamp of the choice. */
  at: string;
};

/**
 * Bump this when the categories offered change (spec point 5: "Bump v when categories change,
 * which re-asks"). A stored consent with a lower `v` is treated as unset.
 */
export const CONSENT_VERSION = 1;

export const CONSENT_STORAGE_KEY = 'ts_consent';

/** 12 months, spec point 5. */
export const CONSENT_MAX_AGE_MS = 365 * 24 * 60 * 60 * 1000;
