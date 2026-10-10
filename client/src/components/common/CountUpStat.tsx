import { useCountUp } from '@/lib/use-count-up';

type Props = {
  /**
   * Always a resolved, non-null number. Callers must omit the stat entirely
   * when its source value is `null` (spec task 2.6's rule) — never pass `0`
   * as a stand-in for "no data yet".
   */
  value: number;
  suffix?: string;
};

/**
 * Animated numeral for a trust stat (spec task 2.9E), e.g. "15,000+". Trust
 * stats only — guests served today, possibly others later.
 *
 * NEVER use this for a price. See use-count-up.ts for the full rationale;
 * prices render instantly through `formatPeso`, everywhere, always.
 */
export default function CountUpStat({ value, suffix = '+' }: Props) {
  const { ref, value: animated } = useCountUp(value);
  return (
    <span ref={ref}>
      {animated.toLocaleString('en-PH')}
      {suffix}
    </span>
  );
}
