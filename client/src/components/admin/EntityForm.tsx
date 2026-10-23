/**
 * `EntityForm` — a generic record editor for the admin/dispatch screens
 * (Week 5 plan, Task 5; reused again by Task 7's driver screen).
 *
 * It owns exactly one job: the label/error/`aria-describedby` wiring, done
 * once, correctly, so every entity screen built on top of it inherits the
 * accessible behaviour for free rather than re-implementing it per screen.
 * Everything entity-specific — the field list, what counts as a change,
 * which mutation runs, how a `CONFLICT` maps onto a field — belongs to the
 * page that uses this component (see `AdminVansPage.tsx`), not here.
 *
 * ## Progressive disclosure, decided from the field list itself
 *
 * `ui-ux-pro-max` ("progressive disclosure dense admin form") backs putting
 * a long record behind a disclosure rather than one wall of inputs. Rather
 * than inventing a van-specific "group" concept this component does not
 * need, the split is read off information already in `EntityFormField`:
 * `required` fields are the identity of the record and stay flat; every
 * optional field goes inside one `Accordion` ("More details"). That rule is
 * entity-agnostic — it is exactly why a driver form can reuse this
 * component unchanged.
 *
 * The disclosure opens by default at `lg:` and stays collapsed below it
 * (CLAUDE.md "Mobile-first" + the brief's instruction for this screen).
 * `window.matchMedia` does not exist in jsdom at all (see
 * `use-hero-parallax.ts` for the same guard elsewhere in this tree), so the
 * check is defensive and simply collapses when it is unavailable — that is
 * also the correct behaviour for a real narrow viewport, not a workaround
 * for the test environment.
 *
 * ## Why each field gets its own id namespace
 *
 * Two `EntityForm`s can be mounted at once (an "Add" form and an "Edit"
 * form on the same page — see `AdminVansPage.tsx`). Both would render a
 * field named `plate`; a hardcoded `entity-field-plate` id would collide
 * and break every `aria-describedby`/`htmlFor` pairing on the second
 * instance. `useId()` gives each mounted `EntityForm` its own namespace.
 */
import { useId, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from '@/components/ui/accordion';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';

export interface EntityFormField {
  name: string;
  label: string;
  type: 'text' | 'number' | 'date' | 'textarea' | 'select';
  options?: ReadonlyArray<{ value: string; label: string }>;
  required?: boolean;
  hint?: string;
}

export interface EntityFormProps {
  fields: readonly EntityFormField[];
  values: Record<string, string>;
  errors: Record<string, string>;
  pending: boolean;
  submitLabel: string;
  onChange: (name: string, value: string) => void;
  onSubmit: () => void;
}

/** Does this environment implement `matchMedia`? jsdom does not at all. */
function prefersWideLayout(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false;
  return window.matchMedia('(min-width: 1024px)').matches;
}

/**
 * One field: a visible `<Label htmlFor>`, the control, an optional hint,
 * and — when `error` is set — a message rendered beside the control and
 * wired to it with `aria-describedby`. Amber, never red, matching every
 * other field-level refusal in this codebase (`ReceiptUpload.tsx`,
 * `ReviewForm.tsx`).
 */
function EntityFormRow({
  idPrefix,
  field,
  value,
  error,
  onChange,
}: {
  idPrefix: string;
  field: EntityFormField;
  value: string;
  error?: string;
  onChange: (value: string) => void;
}) {
  const inputId = `${idPrefix}-${field.name}`;
  const hintId = field.hint ? `${inputId}-hint` : undefined;
  const errorId = error ? `${inputId}-error` : undefined;
  const describedBy = [hintId, errorId].filter(Boolean).join(' ') || undefined;

  return (
    <div className="space-y-1.5">
      <Label htmlFor={inputId}>
        {field.label}
        {field.required ? null : <span className="text-brand-error font-normal"> (optional)</span>}
      </Label>

      {field.type === 'textarea' ? (
        <textarea
          id={inputId}
          aria-describedby={describedBy}
          aria-invalid={error ? true : undefined}
          value={value}
          onChange={(event) => onChange(event.target.value)}
          rows={4}
          className="border-brand-blue-200 tap-target focus-visible:ring-brand-blue-600 w-full rounded-[10px] border bg-white p-3 text-sm focus-visible:outline-none focus-visible:ring-2"
        />
      ) : field.type === 'select' ? (
        <Select value={value} onValueChange={onChange}>
          <SelectTrigger
            id={inputId}
            aria-describedby={describedBy}
            aria-invalid={error ? true : undefined}
            className="tap-target border-brand-blue-200 w-full rounded-[10px] bg-white"
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {(field.options ?? []).map((option) => (
              <SelectItem key={option.value} value={option.value}>
                {option.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      ) : (
        <Input
          id={inputId}
          type={field.type === 'number' ? 'number' : field.type === 'date' ? 'date' : 'text'}
          aria-describedby={describedBy}
          aria-invalid={error ? true : undefined}
          value={value}
          onChange={(event) => onChange(event.target.value)}
          className="tap-target border-brand-blue-200 rounded-[10px] bg-white"
        />
      )}

      {field.hint ? (
        <p id={hintId} className="text-brand-error text-xs">
          {field.hint}
        </p>
      ) : null}
      {error ? (
        <p id={errorId} role="alert" className="text-brand-gold-800 text-xs font-medium">
          {error}
        </p>
      ) : null}
    </div>
  );
}

export default function EntityForm({
  fields,
  values,
  errors,
  pending,
  submitLabel,
  onChange,
  onSubmit,
}: EntityFormProps) {
  const idPrefix = useId();
  // Lazy initial state only — this is "open at lg, collapsed otherwise on
  // mount", not a live-resize listener. Nothing about this screen needs the
  // disclosure to snap open mid-session as a window is dragged.
  const [defaultOpen] = useState<string | undefined>(() =>
    prefersWideLayout() ? 'details' : undefined,
  );

  const identityFields = fields.filter((field) => field.required);
  const moreFields = fields.filter((field) => !field.required);

  return (
    <form
      className="space-y-4"
      onSubmit={(event) => {
        event.preventDefault();
        onSubmit();
      }}
    >
      {identityFields.map((field) => (
        <EntityFormRow
          key={field.name}
          idPrefix={idPrefix}
          field={field}
          value={values[field.name] ?? ''}
          error={errors[field.name]}
          onChange={(value) => onChange(field.name, value)}
        />
      ))}

      {moreFields.length > 0 ? (
        <Accordion type="single" collapsible defaultValue={defaultOpen}>
          <AccordionItem value="details">
            <AccordionTrigger className="tap-target text-brand-ink text-sm font-semibold">
              More details ({moreFields.length})
            </AccordionTrigger>
            <AccordionContent>
              <div className="space-y-4 pt-2">
                {moreFields.map((field) => (
                  <EntityFormRow
                    key={field.name}
                    idPrefix={idPrefix}
                    field={field}
                    value={values[field.name] ?? ''}
                    error={errors[field.name]}
                    onChange={(value) => onChange(field.name, value)}
                  />
                ))}
              </div>
            </AccordionContent>
          </AccordionItem>
        </Accordion>
      ) : null}

      <Button
        type="submit"
        disabled={pending}
        className="tap-target bg-brand-blue-700 hover:bg-brand-blue-800 w-full rounded-[10px] font-semibold text-white transition-colors sm:w-auto"
      >
        {pending ? 'Saving…' : submitLabel}
      </Button>
    </form>
  );
}
