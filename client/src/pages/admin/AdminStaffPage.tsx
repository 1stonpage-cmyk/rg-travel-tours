/**
 * The Staff screen (staff accounts, task 1E; owner decisions 2026-10-23).
 *
 * Every procedure behind it is `admin.staffUsers.*`, an `adminProcedure(
 * 'staffAccounts')` — owner only. The menu hides the link from finance and
 * dispatcher, and this page does not re-check the role itself: hiding a link
 * is a convenience, the refusal is the server's. A non-owner who types the
 * URL gets the page shell and an amber "only the owner" notice, never data.
 *
 * ## The temporary password
 *
 * The owner types it (create, reset); it is never generated, shown back,
 * emailed or kept in state after the request. The form clears it as soon as
 * the server answers. The holder must replace it at their next sign-in, and
 * the card says so ("Must set a new password") until they have.
 *
 * ## Same inline two-step confirm as the Drivers screen
 *
 * Deactivate and reset sign the person out immediately, so each opens a
 * panel under the card that says plainly what will happen. Focus lands on
 * the safe answer. The panels are amber, never red. Reactivate has no
 * confirm: it is the undo and signs nobody out.
 *
 * ## The owner's own row
 *
 * It carries "You" and offers Edit (name only), with the role fixed — and
 * neither Deactivate nor Reset password. The server refuses all three on the
 * own account (it cannot lock itself out); not offering them is the polite
 * half. Role is always spelled out in words, and Active/Inactive likewise:
 * colour is reinforcement, never the only signal.
 */
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Loader2 } from 'lucide-react';
import { TRPCClientError } from '@trpc/client';
import {
  ADMIN_ROLES,
  createStaffUserInputSchema,
  resetStaffPasswordInputSchema,
  updateStaffUserInputSchema,
  type AdminRole,
} from '@rg/shared';
import PasswordField from '@/components/admin/PasswordField';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { trpc } from '@/lib/trpc';

const ROLE_LABELS: Record<AdminRole, string> = {
  owner: 'Owner',
  finance: 'Finance',
  dispatcher: 'Dispatcher',
};

const ROLE_HELP: Record<AdminRole, string> = {
  owner: 'Everything, including staff accounts.',
  finance: 'Bookings, payments, refunds and reports.',
  dispatcher: 'Bookings, calendar, vans, drivers and reviews.',
};

const ROLE_BADGE_CLASS: Record<AdminRole, string> = {
  owner: 'border-0 bg-brand-gold-100 text-brand-gold-800',
  finance: 'border-0 bg-brand-blue-50 text-brand-blue-900',
  dispatcher: 'border-0 bg-brand-blue-100 text-brand-blue-900',
};

const NOTICE_CLASS =
  'border-brand-warning/30 bg-brand-gold-100 text-brand-gold-800 rounded-lg border p-3 text-sm font-medium';

const SELECT_CLASS =
  'border-input tap-target focus-visible:border-ring focus-visible:ring-ring/50 w-full rounded-md border bg-transparent px-3 text-base shadow-xs outline-none focus-visible:ring-[3px] disabled:cursor-not-allowed disabled:opacity-50 md:text-sm';

/** The server's own sentence for a refusal it chose; calm fixed text for everything else. */
function describeStaffError(error: unknown, fallback: string): string {
  if (error instanceof TRPCClientError) {
    const status = error.data?.httpStatus;
    if (status === 403 || status === 401) return 'Only the owner can manage staff accounts.';
    if (status === 400) return 'Please check the details and try again.';
    if (typeof status === 'number' && status < 500 && status !== 429) return error.message;
    if (status === 429) return 'Too many attempts. Wait a few minutes and try again.';
  }
  return fallback;
}

/** First issue per field from a Zod parse, keyed by the field it belongs to. */
function fieldErrors(issues: readonly { path: PropertyKey[]; message: string }[]) {
  const out: Record<string, string> = {};
  for (const issue of issues) {
    const key = String(issue.path[0] ?? '');
    if (key && !(key in out)) out[key] = issue.message;
  }
  return out;
}

function formatLastSignIn(value: Date | string | null): string {
  if (!value) return 'Has not signed in yet';
  return `Last signed in ${new Date(value).toLocaleString('en-PH', {
    timeZone: 'Asia/Manila',
    dateStyle: 'medium',
    timeStyle: 'short',
  })}`;
}

function RoleSelect({
  id,
  value,
  onChange,
  disabled,
}: {
  id: string;
  value: AdminRole;
  onChange: (role: AdminRole) => void;
  disabled?: boolean;
}) {
  return (
    <select
      id={id}
      value={value}
      disabled={disabled}
      onChange={(event) => onChange(event.target.value as AdminRole)}
      className={SELECT_CLASS}
    >
      {ADMIN_ROLES.map((role) => (
        <option key={role} value={role}>
          {ROLE_LABELS[role]}
        </option>
      ))}
    </select>
  );
}

function AddStaffForm({ onCreated }: { onCreated: (name: string) => void }) {
  const utils = trpc.useUtils();
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<AdminRole>('dispatcher');
  const [tempPassword, setTempPassword] = useState('');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [banner, setBanner] = useState<string | null>(null);

  const create = trpc.admin.staffUsers.create.useMutation({
    onSuccess: (_result, variables) => {
      setName('');
      setEmail('');
      setRole('dispatcher');
      setTempPassword('');
      setErrors({});
      setBanner(null);
      void utils.admin.staffUsers.list.invalidate();
      onCreated(variables.name);
    },
    onError: (error) => {
      // The password is not kept after a failed attempt either way: the
      // owner retypes it rather than leaving it sitting in the field.
      setTempPassword('');
      setBanner(describeStaffError(error, 'Could not add this person. Nothing was changed.'));
    },
  });

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBanner(null);
    const parsed = createStaffUserInputSchema.safeParse({ name, email, role, tempPassword });
    if (!parsed.success) {
      setErrors(fieldErrors(parsed.error.issues));
      return;
    }
    setErrors({});
    create.mutate(parsed.data);
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-brand-blue-900 text-lg">Add a staff member</CardTitle>
      </CardHeader>
      <CardContent>
        <form onSubmit={onSubmit} noValidate className="space-y-4">
          {banner ? (
            <p role="alert" className={NOTICE_CLASS}>
              {banner}
            </p>
          ) : null}

          <div className="space-y-1.5">
            <Label htmlFor="staff-new-name">Name</Label>
            <Input
              id="staff-new-name"
              autoComplete="off"
              value={name}
              onChange={(event) => setName(event.target.value)}
              aria-invalid={errors.name ? true : undefined}
              aria-describedby={errors.name ? 'staff-new-name-error' : undefined}
              className="tap-target"
            />
            {errors.name ? (
              <p id="staff-new-name-error" className="text-brand-error text-sm font-medium">
                {errors.name}
              </p>
            ) : null}
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="staff-new-email">Email</Label>
            <Input
              id="staff-new-email"
              type="email"
              autoComplete="off"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              aria-invalid={errors.email ? true : undefined}
              aria-describedby={errors.email ? 'staff-new-email-error' : 'staff-new-email-hint'}
              className="tap-target"
            />
            <p id="staff-new-email-hint" className="text-muted-foreground text-xs">
              They sign in with this email.
            </p>
            {errors.email ? (
              <p id="staff-new-email-error" className="text-brand-error text-sm font-medium">
                {errors.email}
              </p>
            ) : null}
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="staff-new-role">Role</Label>
            <RoleSelect id="staff-new-role" value={role} onChange={setRole} />
            <p className="text-muted-foreground text-xs">{ROLE_HELP[role]}</p>
          </div>

          <PasswordField
            label="Temporary password"
            value={tempPassword}
            onChange={setTempPassword}
            autoComplete="new-password"
            hint="At least 12 characters. Give it to them in person — it is not emailed. They must choose their own at first sign-in."
            error={errors.tempPassword}
          />

          <Button type="submit" disabled={create.isPending} className="tap-target w-full sm:w-auto">
            {create.isPending ? (
              <>
                <Loader2 className="mr-2 size-4 animate-spin" aria-hidden="true" />
                Adding…
              </>
            ) : (
              'Add staff member'
            )}
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}

/** One row of `admin.staffUsers.list` (the server never sends a hash). */
interface StaffRow {
  id: number;
  name: string;
  email: string;
  role: AdminRole;
  isActive: boolean;
  mustChangePassword: boolean;
  lastLoginAt: Date | string | null;
}
type Panel = { kind: 'edit' | 'reset' | 'deactivate'; id: number } | null;

function EditPanel({
  user,
  isSelf,
  onDone,
  onSaved,
}: {
  user: StaffRow;
  isSelf: boolean;
  onDone: () => void;
  onSaved: (message: string) => void;
}) {
  const utils = trpc.useUtils();
  const [name, setName] = useState(user.name);
  const [role, setRole] = useState<AdminRole>(user.role);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [banner, setBanner] = useState<string | null>(null);

  const update = trpc.admin.staffUsers.update.useMutation({
    onSuccess: () => {
      void utils.admin.staffUsers.list.invalidate();
      onSaved(`Saved changes to ${name.trim()}.`);
    },
    onError: (error) =>
      setBanner(describeStaffError(error, 'Could not save these changes. Nothing was changed.')),
  });

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBanner(null);
    const parsed = updateStaffUserInputSchema.safeParse({ id: user.id, name, role });
    if (!parsed.success) {
      setErrors(fieldErrors(parsed.error.issues));
      return;
    }
    setErrors({});
    update.mutate(parsed.data);
  }

  const idBase = `staff-edit-${user.id}`;
  return (
    <form
      onSubmit={onSubmit}
      noValidate
      aria-label={`Edit ${user.name}`}
      className="bg-brand-blue-50 mt-3 space-y-4 rounded-lg p-4"
    >
      {banner ? (
        <p role="alert" className={NOTICE_CLASS}>
          {banner}
        </p>
      ) : null}
      <div className="space-y-1.5">
        <Label htmlFor={`${idBase}-name`}>Name</Label>
        <Input
          id={`${idBase}-name`}
          value={name}
          onChange={(event) => setName(event.target.value)}
          aria-invalid={errors.name ? true : undefined}
          aria-describedby={errors.name ? `${idBase}-name-error` : undefined}
          className="tap-target bg-background"
        />
        {errors.name ? (
          <p id={`${idBase}-name-error`} className="text-brand-error text-sm font-medium">
            {errors.name}
          </p>
        ) : null}
      </div>
      <div className="space-y-1.5">
        <Label htmlFor={`${idBase}-role`}>Role</Label>
        <RoleSelect id={`${idBase}-role`} value={role} onChange={setRole} disabled={isSelf} />
        <p className="text-muted-foreground text-xs">
          {isSelf
            ? 'You cannot change your own role.'
            : 'A role change applies from their next request.'}
        </p>
      </div>
      <div className="flex flex-wrap gap-2">
        <Button type="submit" size="sm" className="tap-target" disabled={update.isPending}>
          {update.isPending ? 'Saving…' : 'Save changes'}
        </Button>
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="tap-target"
          disabled={update.isPending}
          onClick={onDone}
        >
          Cancel
        </Button>
      </div>
    </form>
  );
}

function ResetPanel({
  user,
  onDone,
  onReset,
}: {
  user: StaffRow;
  onDone: () => void;
  onReset: (message: string) => void;
}) {
  const utils = trpc.useUtils();
  const [tempPassword, setTempPassword] = useState('');
  const [error, setError] = useState<string | undefined>();
  const [banner, setBanner] = useState<string | null>(null);

  const reset = trpc.admin.staffUsers.resetPassword.useMutation({
    onSuccess: () => {
      setTempPassword('');
      void utils.admin.staffUsers.list.invalidate();
      onReset(
        `${user.name} is signed out. They must use the temporary password you set, then choose their own.`,
      );
    },
    onError: (err) => {
      setTempPassword('');
      setBanner(describeStaffError(err, 'Could not reset this password. Nothing was changed.'));
    },
  });

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBanner(null);
    const parsed = resetStaffPasswordInputSchema.safeParse({ id: user.id, tempPassword });
    if (!parsed.success) {
      setError(fieldErrors(parsed.error.issues).tempPassword);
      return;
    }
    setError(undefined);
    reset.mutate(parsed.data);
  }

  return (
    <form
      onSubmit={onSubmit}
      noValidate
      aria-label={`Reset password for ${user.name}`}
      className={`${NOTICE_CLASS} mt-3 space-y-4 font-normal`}
    >
      <p className="font-medium">
        Reset the password for {user.name}? This signs them out of every device now. They will have
        to use the temporary password below and then choose their own.
      </p>
      {banner ? (
        <p role="alert" className="font-medium">
          {banner}
        </p>
      ) : null}
      <PasswordField
        label="New temporary password"
        value={tempPassword}
        onChange={setTempPassword}
        autoComplete="new-password"
        hint="At least 12 characters. Give it to them in person."
        error={error}
      />
      <div className="flex flex-wrap gap-2">
        <Button type="submit" size="sm" className="tap-target" disabled={reset.isPending}>
          {reset.isPending ? 'Resetting…' : `Reset and sign out ${user.name}`}
        </Button>
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="tap-target"
          disabled={reset.isPending}
          onClick={onDone}
        >
          Cancel
        </Button>
      </div>
    </form>
  );
}

function DeactivatePanel({
  user,
  onDone,
  onDeactivated,
}: {
  user: StaffRow;
  onDone: () => void;
  onDeactivated: (message: string) => void;
}) {
  const utils = trpc.useUtils();
  const cancelRef = useRef<HTMLButtonElement | null>(null);
  const [banner, setBanner] = useState<string | null>(null);

  // Focus lands on the safe answer, so a stray Enter keeps the account on.
  useEffect(() => {
    cancelRef.current?.focus();
  }, []);

  const setActive = trpc.admin.staffUsers.setActive.useMutation({
    onSuccess: () => {
      void utils.admin.staffUsers.list.invalidate();
      onDeactivated(`${user.name} is deactivated and signed out.`);
    },
    onError: (error) =>
      setBanner(
        describeStaffError(error, 'Could not deactivate this account. Nothing was changed.'),
      ),
  });

  return (
    <div
      role="group"
      aria-label={`Confirm deactivating ${user.name}`}
      className={`${NOTICE_CLASS} mt-3 font-normal`}
    >
      <p className="font-medium">
        Deactivate {user.name}? This signs them out on every device right away and they can no
        longer sign in. Their history is kept, and you can reactivate them later.
      </p>
      {banner ? (
        <p role="alert" className="mt-2 font-medium">
          {banner}
        </p>
      ) : null}
      <div className="mt-3 flex flex-wrap gap-2">
        <Button
          type="button"
          size="sm"
          className="tap-target"
          disabled={setActive.isPending}
          onClick={() => setActive.mutate({ id: user.id, isActive: false })}
        >
          {setActive.isPending ? 'Deactivating…' : `Yes, deactivate ${user.name}`}
        </Button>
        <Button
          ref={cancelRef}
          type="button"
          variant="outline"
          size="sm"
          className="tap-target"
          disabled={setActive.isPending}
          onClick={onDone}
        >
          Keep {user.name} active
        </Button>
      </div>
    </div>
  );
}

export default function AdminStaffPage() {
  const utils = trpc.useUtils();
  const list = trpc.admin.staffUsers.list.useQuery(undefined, { retry: false });
  const me = trpc.staffAuth.me.useQuery(undefined, { retry: false });
  const [panel, setPanel] = useState<Panel>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [rowBanner, setRowBanner] = useState<string | null>(null);

  const reactivate = trpc.admin.staffUsers.setActive.useMutation({
    onSuccess: (_result, variables) => {
      const person = list.data?.find((u) => u.id === variables.id);
      setRowBanner(null);
      setNotice(`${person?.name ?? 'The account'} is active again. They can sign in.`);
      void utils.admin.staffUsers.list.invalidate();
    },
    onError: (error) =>
      setRowBanner(describeStaffError(error, 'Could not reactivate this account.')),
  });

  const users = list.data ?? [];
  const selfId = me.data?.userId;

  function closePanelWith(message: string | null) {
    setPanel(null);
    setNotice(message);
    setRowBanner(null);
  }

  return (
    <div className="mx-auto max-w-3xl px-4 py-6">
      <h1 className="text-brand-blue-900 text-2xl font-bold">Staff accounts</h1>
      <p className="text-muted-foreground mt-1 text-sm">
        Only the owner sees this page. Staff sign in at the staff sign-in with their email.
      </p>

      {notice ? (
        <p
          role="status"
          className="bg-brand-blue-50 text-brand-blue-900 mt-4 rounded-lg p-3 text-sm font-medium"
        >
          {notice}
        </p>
      ) : null}

      <div className="mt-6">
        <AddStaffForm
          onCreated={(name) =>
            setNotice(`${name} was added. Give them the temporary password in person.`)
          }
        />
      </div>

      <h2 className="text-brand-blue-900 mt-8 text-lg font-semibold">Everyone with a login</h2>

      {rowBanner ? (
        <p role="alert" className={`${NOTICE_CLASS} mt-4`}>
          {rowBanner}
        </p>
      ) : null}

      {list.isPending ? (
        <p className="text-muted-foreground mt-4 flex items-center gap-2 text-sm">
          <Loader2 className="size-4 animate-spin" aria-hidden="true" />
          Loading staff…
        </p>
      ) : list.isError ? (
        <p role="alert" className={`${NOTICE_CLASS} mt-4`}>
          {describeStaffError(
            list.error,
            'We could not load staff accounts. Try again in a moment.',
          )}
        </p>
      ) : (
        <ul className="mt-4 space-y-4">
          {users.map((user) => {
            const isSelf = user.id === selfId;
            const open = panel?.id === user.id ? panel.kind : null;
            const reactivating = reactivate.isPending && reactivate.variables?.id === user.id;

            return (
              <li key={user.id}>
                <Card>
                  <CardContent className="pt-6">
                    <div className="flex flex-wrap items-start justify-between gap-2">
                      <div className="min-w-0">
                        <p className="text-brand-blue-900 font-semibold">
                          {user.name}
                          {isSelf ? (
                            <span className="text-muted-foreground ml-2 text-sm font-normal">
                              (You)
                            </span>
                          ) : null}
                        </p>
                        <p className="text-muted-foreground break-all text-sm">{user.email}</p>
                      </div>
                      <div className="flex flex-wrap items-center gap-2">
                        <Badge className={ROLE_BADGE_CLASS[user.role]}>
                          Role: {ROLE_LABELS[user.role]}
                        </Badge>
                        <Badge
                          className={
                            user.isActive
                              ? 'bg-brand-blue-50 text-brand-blue-900 border-0'
                              : 'bg-muted text-foreground border-0'
                          }
                        >
                          {user.isActive ? 'Active' : 'Inactive'}
                        </Badge>
                      </div>
                    </div>

                    <p className="text-muted-foreground mt-2 text-xs">
                      {formatLastSignIn(user.lastLoginAt)}
                      {user.mustChangePassword ? ' · Must set a new password' : ''}
                    </p>

                    <div className="mt-3 flex flex-wrap items-center gap-2">
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        className="tap-target"
                        onClick={() => setPanel({ kind: 'edit', id: user.id })}
                      >
                        Edit
                      </Button>
                      {!isSelf ? (
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          className="tap-target"
                          onClick={() => setPanel({ kind: 'reset', id: user.id })}
                        >
                          Reset password
                        </Button>
                      ) : null}
                      {!isSelf && user.isActive ? (
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          className="tap-target"
                          onClick={() => setPanel({ kind: 'deactivate', id: user.id })}
                        >
                          Deactivate
                        </Button>
                      ) : null}
                      {!user.isActive ? (
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          className="tap-target"
                          disabled={reactivate.isPending}
                          onClick={() => {
                            setNotice(null);
                            reactivate.mutate({ id: user.id, isActive: true });
                          }}
                        >
                          {reactivating ? 'Reactivating…' : 'Reactivate'}
                        </Button>
                      ) : null}
                    </div>

                    {open === 'edit' ? (
                      <EditPanel
                        user={user}
                        isSelf={isSelf}
                        onDone={() => setPanel(null)}
                        onSaved={closePanelWith}
                      />
                    ) : null}
                    {open === 'reset' ? (
                      <ResetPanel
                        user={user}
                        onDone={() => setPanel(null)}
                        onReset={closePanelWith}
                      />
                    ) : null}
                    {open === 'deactivate' ? (
                      <DeactivatePanel
                        user={user}
                        onDone={() => setPanel(null)}
                        onDeactivated={closePanelWith}
                      />
                    ) : null}
                  </CardContent>
                </Card>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
