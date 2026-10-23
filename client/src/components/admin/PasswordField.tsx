/**
 * A password input with a show/hide toggle, for the staff screens that type a
 * password (a temporary one on Staff, current/new on Change password).
 *
 * Mirrors the sign-in screen's field: `autoComplete` is the caller's choice
 * (`new-password` or `current-password`) so a password manager does the right
 * thing, paste is never blocked, and the toggle's `aria-label` says what it
 * will DO. The error sits under the field and is tied to it with
 * `aria-describedby`, alongside any hint.
 */
import { useId, useState } from 'react';
import { Eye, EyeOff } from 'lucide-react';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

interface PasswordFieldProps {
  label: string;
  value: string;
  onChange: (value: string) => void;
  autoComplete: 'new-password' | 'current-password';
  hint?: string;
  error?: string | undefined;
  disabled?: boolean;
}

export default function PasswordField({
  label,
  value,
  onChange,
  autoComplete,
  hint,
  error,
  disabled,
}: PasswordFieldProps) {
  const id = useId();
  const [revealed, setRevealed] = useState(false);
  const hintId = `${id}-hint`;
  const errorId = `${id}-error`;
  const describedBy = [hint ? hintId : null, error ? errorId : null].filter(Boolean).join(' ');

  return (
    <div className="space-y-1.5">
      <Label htmlFor={id}>{label}</Label>
      <div className="relative">
        <Input
          id={id}
          type={revealed ? 'text' : 'password'}
          autoComplete={autoComplete}
          value={value}
          disabled={disabled}
          onChange={(event) => onChange(event.target.value)}
          aria-invalid={error ? true : undefined}
          aria-describedby={describedBy || undefined}
          className="tap-target border-brand-blue-200 rounded-[10px] bg-white pr-12"
        />
        <button
          type="button"
          onClick={() => setRevealed((shown) => !shown)}
          aria-label={revealed ? `Hide ${label.toLowerCase()}` : `Show ${label.toLowerCase()}`}
          aria-pressed={revealed}
          className="text-muted-foreground hover:text-brand-blue-700 focus-visible:ring-brand-blue-600 absolute inset-y-0 right-0 flex w-12 items-center justify-center rounded-r-[10px] transition-colors focus-visible:outline-none focus-visible:ring-2"
        >
          {revealed ? (
            <EyeOff className="size-5" aria-hidden="true" />
          ) : (
            <Eye className="size-5" aria-hidden="true" />
          )}
        </button>
      </div>
      {hint ? (
        <p id={hintId} className="text-muted-foreground text-xs">
          {hint}
        </p>
      ) : null}
      {error ? (
        <p id={errorId} role="alert" className="text-brand-error text-sm font-medium">
          {error}
        </p>
      ) : null}
    </div>
  );
}
