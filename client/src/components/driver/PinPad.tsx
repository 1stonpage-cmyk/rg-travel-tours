/**
 * The driver portal's PIN entry (Week 6 plan, Task 9 — BUILD_SPEC §8).
 *
 * Decisions are from `.superpowers/sdd/.../driver-screen-design.md`
 * (researched with `ui-ux-pro-max` on 2026-10-15) and are implemented here
 * rather than re-derived:
 *
 *  - **An on-screen pad AS WELL AS a field.** `inputMode="numeric"` brings
 *    the phone's own numeric keyboard up, and that is still the right
 *    attribute — but the pad is what a thumb aims at while the other hand
 *    is holding a manifest, and it is what survives a soft keyboard that
 *    covers the lower half of a small screen.
 *  - **Unmasked by default** (owner-accepted 2026-10-15, Q6). The
 *    realistic threat beside a van is a mistype, and five mistypes is a
 *    fifteen-minute lockout plus a phone call to the office; a
 *    shoulder-surfer standing next to a driver is not. The toggle is there
 *    for the driver who wants it, defaulting to visible.
 *  - **~56px targets, 44px floor.** `tap-target` is the house 44px utility
 *    and stays on every control; `h-14` (56px) is what the digits actually
 *    get, because a thumb aiming at a moving target needs the slack.
 *    `gap-2` keeps 8px between adjacent targets.
 *  - **No hover-only affordance.** Every state here is visible without a
 *    pointer: the digits are large and bordered, pressed state comes from
 *    `:active` via `.press`, and the toggle says what it will do in its
 *    own `aria-label`.
 *
 * Controlled, with no state of its own except whether the PIN is masked —
 * the login page owns the value, because the login page is what submits
 * it. `length` is a prop for the same reason: the six comes from
 * `driverLoginSchema`, which the page validates against, and one component
 * deciding its own idea of how long a PIN is would be a second source of
 * truth for a number the server already enforces.
 */
import { useState } from 'react';
import { Delete, Eye, EyeOff } from 'lucide-react';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

export interface PinPadProps {
  value: string;
  onChange: (next: string) => void;
  /** How many digits a complete PIN has. From the shared login schema. */
  length: number;
  disabled?: boolean;
  /** Id of the form's single error notice, for `aria-describedby`. */
  describedBy?: string;
}

const DIGITS = ['1', '2', '3', '4', '5', '6', '7', '8', '9'] as const;

/**
 * Shared by the digits, Clear and Delete. `h-14` is the real 56px size;
 * `tap-target` is the 44px floor the house utility and the guard tests
 * know about. Border and weight carry the affordance, not colour alone,
 * and nothing here depends on hover.
 */
const KEY_CLASS =
  'tap-target press border-brand-blue-200 bg-background text-brand-blue-900 focus-visible:ring-brand-blue-600 active:bg-brand-blue-50 flex h-14 items-center justify-center rounded-xl border-2 font-semibold focus-visible:outline-none focus-visible:ring-2';

export default function PinPad({
  value,
  onChange,
  length,
  disabled = false,
  describedBy,
}: PinPadProps) {
  const [revealed, setRevealed] = useState(true);

  /** Digits only, never longer than a PIN — wherever they came from. */
  function set(next: string) {
    onChange(next.replace(/\D/g, '').slice(0, length));
  }

  return (
    <div className="space-y-3">
      <div className="space-y-1.5">
        <Label htmlFor="driver-pin" className="text-brand-blue-900 text-base">
          PIN
        </Label>
        <div className="relative">
          <Input
            id="driver-pin"
            name="pin"
            /*
             * NOT `type="number"` — that would strip a leading zero and
             * bring up a spinner nobody wants on a PIN. `inputMode` is
             * what summons the numeric keyboard; `one-time-code` is what
             * stops a password manager offering a saved website password.
             */
            type={revealed ? 'text' : 'password'}
            inputMode="numeric"
            autoComplete="one-time-code"
            pattern="[0-9]*"
            maxLength={length}
            value={value}
            disabled={disabled}
            onChange={(event) => set(event.target.value)}
            aria-describedby={describedBy}
            className="tap-target h-14 pr-14 text-center text-2xl font-semibold tracking-[0.4em]"
          />
          <button
            type="button"
            onClick={() => setRevealed((shown) => !shown)}
            aria-label={revealed ? 'Hide PIN' : 'Show PIN'}
            aria-pressed={revealed}
            className="text-brand-blue-700 focus-visible:ring-brand-blue-600 tap-target absolute inset-y-0 right-0 flex w-14 items-center justify-center rounded-r-md focus-visible:outline-none focus-visible:ring-2"
          >
            {revealed ? (
              <EyeOff className="size-6" aria-hidden="true" />
            ) : (
              <Eye className="size-6" aria-hidden="true" />
            )}
          </button>
        </div>
      </div>

      {/*
       * A `group` with a name, so a screen reader announces the twelve keys
       * as one keypad rather than twelve loose buttons — and so a test can
       * assert the pad exists as a unit at all.
       */}
      <div role="group" aria-label="PIN keypad" className="grid grid-cols-3 gap-2">
        {DIGITS.map((digit) => (
          <button
            key={digit}
            type="button"
            disabled={disabled}
            onClick={() => set(value + digit)}
            className={`${KEY_CLASS} text-2xl`}
          >
            {digit}
          </button>
        ))}
        <button
          type="button"
          disabled={disabled}
          onClick={() => onChange('')}
          className={`${KEY_CLASS} text-base`}
        >
          Clear
        </button>
        <button
          type="button"
          disabled={disabled}
          onClick={() => set(value + '0')}
          className={`${KEY_CLASS} text-2xl`}
        >
          0
        </button>
        <button
          type="button"
          disabled={disabled}
          onClick={() => onChange(value.slice(0, -1))}
          /*
           * Icon AND word: an icon alone is a guess at midday behind a
           * windscreen, and this key is next to the digits a driver is
           * aiming at.
           */
          className={`${KEY_CLASS} gap-1.5 text-base`}
        >
          <Delete className="size-5" aria-hidden="true" />
          Delete
        </button>
      </div>
    </div>
  );
}
