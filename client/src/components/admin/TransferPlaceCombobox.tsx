/**
 * `TransferPlaceCombobox` — a type-to-search picker for one `transfer_places`
 * row, reused for both the "From place" and "To place" fields of the
 * transfer-route form (owner decision 2026-11-08: flexible places/routes/
 * vehicle types — see
 * `docs/superpowers/plans/2026-11-08-flexible-routes.md`).
 *
 * Plain HTML, not a Radix `Popover`/`Command` pair — this project has
 * neither installed (`client/src/components/ui/`), and the brief does not
 * call for one. A labelled `role="combobox"` text input opens a `listbox`
 * of matching places below it; selecting one calls `onChange(id)` and
 * closes the list.
 *
 * ## "+ Add new place" is an inline affordance, not a navigation
 *
 * The task brief is explicit: adding a place from inside the route form must
 * not leave the route form. Choosing the last option in the list opens a
 * small inline panel (name + "Is an airport" + Add/Cancel) in place of the
 * list, which calls `admin.transferPlaces.create` itself and, on success,
 * invalidates `admin.transferPlaces.list` (so every other open combobox and
 * the Places admin screen see the new row) and calls `onChange` with the new
 * id — the newly created place becomes this field's value without the admin
 * ever leaving the route they were building.
 *
 * ## Why this owns its own mutation rather than taking a callback prop
 *
 * Both the "From place" and "To place" instances on the route form need the
 * identical create-a-place behaviour, and the route form itself has no
 * reason to know how a place is created — that is this component's whole
 * job, the same reasoning `EntityForm` uses for not knowing what a van or a
 * coupon is. The route form only ever reads `value`/`onChange`.
 *
 * ## Inactive places stay choosable, and say so
 *
 * A route may legitimately reference a place an admin later deactivated —
 * `admin.transferRoutes.list` already shows that case with its own "inactive"
 * state, and this combobox must not hide the place a stored route already
 * points at. Every option therefore renders, with `" (inactive)"` appended
 * for a place whose `isActive` is false, rather than filtering the list down
 * to active places only.
 */
import { useId, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import type { TransferPlaceAdminListRow } from '@rg/shared';
import { firstValidationMessage } from '@/lib/field-errors';
import { trpc } from '@/lib/trpc';

const FIELD = 'tap-target border-brand-blue-200 rounded-[10px] bg-white';
const LISTBOX =
  'border-brand-blue-200 absolute z-20 mt-1 max-h-60 w-full overflow-auto rounded-[10px] border bg-white py-1 text-sm shadow-lg';
const OPTION =
  'tap-target w-full rounded-none px-3 py-2 text-left text-sm text-brand-ink hover:bg-brand-blue-50';
const ADD_OPTION = `${OPTION} text-brand-blue-700 font-semibold`;
const ROW_ERROR = 'text-brand-gold-800 text-xs font-medium';
const PANEL = 'border-brand-blue-200 mt-1 space-y-3 rounded-[10px] border bg-white p-3';

function placeLabel(place: TransferPlaceAdminListRow): string {
  return place.isActive ? place.name : `${place.name} (inactive)`;
}

export interface TransferPlaceComboboxProps {
  label: string;
  places: readonly TransferPlaceAdminListRow[];
  value: number | null;
  onChange: (id: number) => void;
  error?: string;
  hint?: string;
}

export default function TransferPlaceCombobox({
  label,
  places,
  value,
  onChange,
  error,
  hint,
}: TransferPlaceComboboxProps) {
  const idPrefix = useId();
  const inputId = `${idPrefix}-input`;
  const listboxId = `${idPrefix}-listbox`;
  const errorId = `${idPrefix}-error`;
  const hintId = `${idPrefix}-hint`;

  const utils = trpc.useUtils();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState('');
  const [newIsAirport, setNewIsAirport] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);

  const create = trpc.admin.transferPlaces.create.useMutation({
    onSuccess: (result) => {
      void utils.admin.transferPlaces.list.invalidate();
      onChange(result.id);
      setCreating(false);
      setNewName('');
      setNewIsAirport(false);
      setCreateError(null);
      setOpen(false);
      setQuery('');
    },
    onError: (mutationError) => {
      // CLAUDE.md: "No form, public or admin, may show raw Zod JSON." A
      // server-side input-validation refusal (e.g. the name exceeding
      // `transferPlaceCreateInputSchema`'s `max(120)`) must read through
      // the shared helper, never `mutationError.message` bare — that is
      // tRPC's own default, which is the raw stringified issue list, the
      // same trap this project has already fixed once for a query
      // (CLAUDE.md, "Checkout & payments", BUG-120's sibling note).
      setCreateError(
        firstValidationMessage(mutationError) ??
          mutationError.message ??
          'Could not add this place.',
      );
    },
  });

  const selected = places.find((place) => place.id === value) ?? null;
  const filtered = places.filter((place) =>
    place.name.toLowerCase().includes(query.trim().toLowerCase()),
  );

  function openList() {
    setQuery(selected?.name ?? '');
    setOpen(true);
    setCreating(false);
  }

  function selectPlace(place: TransferPlaceAdminListRow) {
    onChange(place.id);
    setOpen(false);
    setQuery('');
  }

  function startCreate() {
    setCreating(true);
    setNewName(query.trim());
    setCreateError(null);
  }

  function submitCreate() {
    const name = newName.trim();
    if (name === '') {
      setCreateError('Enter a name for the new place.');
      return;
    }
    create.mutate({ name, isAirport: newIsAirport, destinationId: null });
  }

  const describedBy = [hint ? hintId : null, error ? errorId : null].filter(Boolean).join(' ');

  return (
    <div className="relative space-y-1.5">
      <Label htmlFor={inputId}>{label}</Label>
      <Input
        id={inputId}
        role="combobox"
        aria-expanded={open}
        aria-controls={listboxId}
        aria-autocomplete="list"
        aria-describedby={describedBy || undefined}
        aria-invalid={error ? true : undefined}
        autoComplete="off"
        className={FIELD}
        value={open ? query : (selected?.name ?? '')}
        onFocus={openList}
        onChange={(event) => {
          setQuery(event.target.value);
          setOpen(true);
          setCreating(false);
        }}
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            setOpen(false);
            setCreating(false);
          }
        }}
      />
      {hint ? (
        <p id={hintId} className="text-brand-error text-xs">
          {hint}
        </p>
      ) : null}
      {error ? (
        <p id={errorId} role="alert" className={ROW_ERROR}>
          {error}
        </p>
      ) : null}

      {open && !creating ? (
        <ul role="listbox" id={listboxId} className={LISTBOX}>
          {filtered.map((place) => (
            <li key={place.id}>
              <button
                type="button"
                role="option"
                aria-selected={place.id === value}
                className={OPTION}
                onClick={() => selectPlace(place)}
              >
                {placeLabel(place)}
              </button>
            </li>
          ))}
          {filtered.length === 0 ? (
            <li className="text-brand-error px-3 py-2 text-sm">No matching places.</li>
          ) : null}
          <li>
            <button type="button" className={ADD_OPTION} onClick={startCreate}>
              + Add new place
            </button>
          </li>
        </ul>
      ) : null}

      {creating ? (
        <div className={PANEL}>
          <div className="space-y-1.5">
            <Label htmlFor={`${idPrefix}-new-name`}>New place name</Label>
            <Input
              id={`${idPrefix}-new-name`}
              className={FIELD}
              value={newName}
              onChange={(event) => setNewName(event.target.value)}
            />
          </div>
          <label
            className="tap-target flex items-center gap-2 text-sm"
            htmlFor={`${idPrefix}-new-airport`}
          >
            <input
              id={`${idPrefix}-new-airport`}
              type="checkbox"
              checked={newIsAirport}
              onChange={(event) => setNewIsAirport(event.target.checked)}
            />
            Is an airport
          </label>
          {createError ? (
            <p role="alert" className={ROW_ERROR}>
              {createError}
            </p>
          ) : null}
          <div className="flex flex-wrap gap-2">
            <Button
              type="button"
              size="sm"
              disabled={create.isPending}
              className="tap-target bg-brand-blue-700 hover:bg-brand-blue-800 rounded-[10px] font-semibold text-white"
              onClick={submitCreate}
            >
              {create.isPending ? 'Adding…' : 'Add place'}
            </Button>
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="tap-target border-brand-blue-200 text-brand-blue-700 rounded-[10px] font-semibold"
              disabled={create.isPending}
              onClick={() => {
                setCreating(false);
                setCreateError(null);
              }}
            >
              Cancel
            </Button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
