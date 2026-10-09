import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import StarRating from '@/components/common/StarRating';

describe('StarRating', () => {
  // Round 1 finding on Task 2.5: the sr-only text used to hardcode
  // "Placeholder value." — announced for real, API-backed ratings too
  // (TourCard, ReviewsSection), telling screen-reader users genuine data
  // was fake. This asserts the accessible text describes the actual
  // value and carries no such claim.
  it('announces the real rating value to screen readers, with no "Placeholder" claim', () => {
    render(<StarRating value={4.7} />);
    const srText = screen.getByText(/out of 5/i);
    expect(srText).toHaveTextContent('4.7 out of 5');
    expect(srText).not.toHaveTextContent(/placeholder/i);
  });

  it('includes the review count in the accessible text when provided', () => {
    render(<StarRating value={4.9} count={68} />);
    const srText = screen.getByText(/out of 5/i);
    expect(srText).toHaveTextContent('4.9 out of 5 from 68 reviews');
    expect(srText).not.toHaveTextContent(/placeholder/i);
  });
});
