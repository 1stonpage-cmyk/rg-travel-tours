import type { ReactNode } from 'react';
import { Button } from '@/components/ui/button';

/**
 * The slice of a TanStack Query `UseQueryResult` this component actually
 * needs. Deliberately not `unknown`/`any` — requiring `data`, `isPending`
 * and `isError` means a caller must hand in something query-shaped (a real
 * `useQuery()`/`trpc.x.useQuery()` result satisfies this structurally),
 * while still being loose enough for tests to pass a plain object literal
 * for each state under test.
 */
export type BoundaryQuery<T> = {
  data: T | undefined;
  isPending: boolean;
  isError: boolean;
  error?: unknown;
  refetch?: () => void;
};

type Props<T> = {
  query: BoundaryQuery<T>;
  /** Occupies the same box as the loaded content — see Skeleton.tsx. */
  skeleton: ReactNode;
  /** Shown instead of `children` when the resolved data is empty. Omit to render `children` as-is. */
  empty?: ReactNode;
  /** Generic, human title for the error state. Never the raw query error. */
  errorTitle: string;
  /** Defaults to `Array.isArray(data) && data.length === 0`. */
  isEmpty?: (data: T) => boolean;
  children: (data: T) => ReactNode;
};

function defaultIsEmpty(data: unknown): boolean {
  return Array.isArray(data) && data.length === 0;
}

/**
 * Shared pending/error/empty/success boundary for every data-driven
 * section. The raw query `error` is accepted on the type so a caller can
 * pass the real thing, but it is never read or rendered here — the error
 * state is always the generic `errorTitle` plus a fixed, human sentence.
 * See `src/__tests__/query-boundary.test.tsx`.
 *
 * Ruling: stale content beats an error box. Under TanStack Query v5, a
 * background refetch failure after an earlier successful load keeps the
 * last-good `data` while flipping `isError` true — on a marketing page,
 * rendering the content we already have is strictly better than replacing
 * it with "could not load" over a transient network blip. The error state
 * only wins when there is no data at all to fall back on.
 */
export default function QueryBoundary<T>({
  query,
  skeleton,
  empty,
  errorTitle,
  isEmpty,
  children,
}: Props<T>) {
  if (query.isPending) return <>{skeleton}</>;

  if (query.isError && query.data === undefined) {
    return <ErrorState title={errorTitle} onRetry={query.refetch} />;
  }

  // Either a clean success, or an `isError` background-refetch failure that
  // still carries stale `data` — both render the same way.
  const data = query.data as T;
  const resolvedIsEmpty = isEmpty ? isEmpty(data) : defaultIsEmpty(data);

  if (empty && resolvedIsEmpty) return <>{empty}</>;

  return <>{children(data)}</>;
}

function ErrorState({ title, onRetry }: { title: string; onRetry?: () => void }) {
  return (
    <div
      role="alert"
      className="border-brand-blue-200 bg-background flex flex-col items-center gap-3 rounded-xl border p-8 text-center"
    >
      <p className="text-brand-error text-base font-semibold">{title}</p>
      <p className="text-muted-foreground text-sm">
        Something went wrong loading this. Please try again.
      </p>
      <Button type="button" variant="outline" className="tap-target" onClick={() => onRetry?.()}>
        Try again
      </Button>
    </div>
  );
}

/**
 * Generic "nothing here yet" slot — a helpful message, not a blank box
 * (ui-ux-pro-max's Feedback/Empty States guidance: show a message and an
 * action rather than leaving empty white space).
 */
export function EmptyState({
  title,
  body,
  action,
}: {
  title: string;
  body?: string;
  action?: ReactNode;
}) {
  return (
    <div className="border-brand-blue-200 flex flex-col items-center gap-2 rounded-xl border border-dashed p-8 text-center">
      <p className="text-brand-blue-900 text-base font-semibold">{title}</p>
      {body && <p className="text-muted-foreground text-sm">{body}</p>}
      {action}
    </div>
  );
}
