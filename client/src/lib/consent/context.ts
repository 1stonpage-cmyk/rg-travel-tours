import { createContext } from 'react';
import type { ConsentCategories } from './types';

export type ConsentContextValue = {
  consent: ConsentCategories;
  /** 'unset' is what makes the banner show — a fresh visitor or a version bump (spec point 5). */
  status: 'unset' | 'set';
  bannerOpen: boolean;
  panelOpen: boolean;
  acceptAll: () => void;
  rejectAll: () => void;
  saveCustom: (categories: ConsentCategories) => void;
  openCustomize: () => void;
  closeCustomize: () => void;
  /** The footer's "Cookie settings" button (task 2C) — always reopens the panel, set or unset. */
  reopen: () => void;
};

/**
 * Split from `ConsentContext.tsx`/`useConsent.ts` so each of those files exports only one thing
 * (a component, a hook) — `react-refresh/only-export-components` otherwise flags a file that
 * mixes the two.
 */
export const ConsentContext = createContext<ConsentContextValue | null>(null);
