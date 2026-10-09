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

  if (query.isError) {
    return <ErrorState title={errorTitle} onRetry={query.refetch} />;
  }

  // Past the pending/error guards above, a well-behaved query has settled
  // into success and `data` is defined — that contract is TanStack Query's,
  // not this component's, so this narrows rather than re-validates it.
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
