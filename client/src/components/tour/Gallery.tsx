import { ChevronLeft, ChevronRight, X } from 'lucide-react';
import { useEffect, useState } from 'react';
import type { TourImage } from '../../../../server/src/routers/public/tours';

type Props = {
  images: TourImage[];
  /** Used only to build a fallback alt/aria-label when a row's own `alt` is empty. */
  title: string;
};

/**
 * The tour detail page's photo gallery (Week 7 plan, Task 2).
 *
 * A hero photo plus up to four thumbnails, mobile-first: on a 360px screen
 * the grid collapses to the hero stacked over a 2-up thumbnail row, same
 * markup, just Tailwind breakpoints. Every `<img>` in both the grid and the
 * lightbox carries a non-empty `alt` — the row's own `alt` when the database
 * has one, otherwise a generated `"<title> photo N"` fallback, never an
 * empty string (a missing admin-authored alt must still describe the photo
 * to a screen reader, not go decorative).
 *
 * The lightbox is a plain controlled `<div role="dialog">`, not a new
 * dependency — Escape, the two arrow keys, a backdrop click and an explicit
 * close button all close or navigate it, and every control is a real
 * `<button>` with its own `aria-label` so nothing here depends on hover.
 */
export default function Gallery({ images, title }: Props) {
  const [openIndex, setOpenIndex] = useState<number | null>(null);

  if (images.length === 0) return null;

  function altFor(image: TourImage, index: number): string {
    return image.alt.trim() || `${title} photo ${index + 1}`;
  }

  const [hero, ...rest] = images;
  const thumbnails = rest.slice(0, 4);

  return (
    <div>
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        <button
          type="button"
          onClick={() => setOpenIndex(0)}
          aria-label={`View photo 1 of ${images.length}: ${altFor(hero!, 0)}`}
          className="press tap-target col-span-2 overflow-hidden rounded-xl focus-visible:outline-none sm:row-span-2"
        >
          <img
            src={hero!.path}
            alt={altFor(hero!, 0)}
            width={hero!.width ?? undefined}
            height={hero!.height ?? undefined}
            loading="eager"
            decoding="async"
            className="aspect-[4/3] size-full object-cover"
          />
        </button>

        {thumbnails.map((image, i) => (
          <button
            key={`${image.path}-${i}`}
            type="button"
            onClick={() => setOpenIndex(i + 1)}
            aria-label={`View photo ${i + 2} of ${images.length}: ${altFor(image, i + 1)}`}
            className="press tap-target overflow-hidden rounded-xl focus-visible:outline-none"
          >
            <img
              src={image.path}
              alt={altFor(image, i + 1)}
              width={image.width ?? undefined}
              height={image.height ?? undefined}
              loading="lazy"
              decoding="async"
              className="aspect-square size-full object-cover"
            />
          </button>
        ))}
      </div>

      {openIndex !== null && (
        <Lightbox
          images={images}
          index={openIndex}
          title={title}
          altFor={altFor}
          onClose={() => setOpenIndex(null)}
          onChange={setOpenIndex}
        />
      )}
    </div>
  );
}

function Lightbox({
  images,
  index,
  title,
  altFor,
  onClose,
  onChange,
}: {
  images: TourImage[];
  index: number;
  title: string;
  altFor: (image: TourImage, index: number) => string;
  onClose: () => void;
  onChange: (index: number) => void;
}) {
  const image = images[index]!;
  const count = images.length;

  function goPrev() {
    onChange((index - 1 + count) % count);
  }
  function goNext() {
    onChange((index + 1) % count);
  }

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') onClose();
      else if (event.key === 'ArrowLeft') goPrev();
      else if (event.key === 'ArrowRight') goNext();
    }
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [index]);

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={`Photo gallery — ${title}`}
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/90 p-4"
      onClick={onClose}
    >
      <button
        type="button"
        onClick={onClose}
        aria-label="Close photo gallery"
        className="press tap-target absolute right-3 top-3 inline-flex items-center justify-center rounded-full bg-white/10 text-white hover:bg-white/20 focus-visible:outline-none sm:right-6 sm:top-6"
      >
        <X className="size-6" aria-hidden="true" />
      </button>

      {count > 1 && (
        <>
          <button
            type="button"
            onClick={(event) => {
              event.stopPropagation();
              goPrev();
            }}
            aria-label="Previous photo"
            className="press tap-target absolute left-2 top-1/2 inline-flex -translate-y-1/2 items-center justify-center rounded-full bg-white/10 text-white hover:bg-white/20 focus-visible:outline-none sm:left-6"
          >
            <ChevronLeft className="size-6" aria-hidden="true" />
          </button>
          <button
            type="button"
            onClick={(event) => {
              event.stopPropagation();
              goNext();
            }}
            aria-label="Next photo"
            className="press tap-target absolute right-2 top-1/2 inline-flex -translate-y-1/2 items-center justify-center rounded-full bg-white/10 text-white hover:bg-white/20 focus-visible:outline-none sm:right-6"
          >
            <ChevronRight className="size-6" aria-hidden="true" />
          </button>
        </>
      )}

      <img
        src={image.path}
        alt={altFor(image, index)}
        onClick={(event) => event.stopPropagation()}
        className="max-h-full max-w-full rounded-lg object-contain"
      />

      <p
        className="absolute bottom-3 left-1/2 -translate-x-1/2 text-sm font-medium text-white/80"
        aria-hidden="true"
      >
        {index + 1} / {count}
      </p>
    </div>
  );
}
