/**
 * "Set a new password" (staff accounts, task 1F; owner decisions 2026-10-23).
 *
 * Two doors lead here. After a sign-in with a temporary password the server
 * says `mustChangePassword` and `AdminLayout` sends every route here until it
 * is done; and any staff member can open it from the menu to change theirs
 * on purpose. It is the same form: current password, new password, confirm.
 *
 * The rules are the server's (`staffAuth.changePassword`): the current
 * password must be right, the new one at least 12 characters and different.
 * The page checks length, match and difference before sending so a typo
 * costs no round trip, and shows the server's own sentence for the rest.
 * Only the server's "current password is not right" ever counts against the
 * throttle, so a client-side refusal never uses up an attempt.
 *
 * On success the flag is gone, this session is kept and every OTHER session
 * of the same person is ended. A forced change continues straight on to the
 * dashboard; a voluntary one stays and says what happened.
 */
import { useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { Loader2 } from 'lucide-react';
import { TRPCClientError } from '@trpc/client';
import { STAFF_PASSWORD_MIN_LENGTH, staffPasswordSchema } from '@rg/shared';
import PasswordField from '@/components/admin/PasswordField';
import { Button } from '@/components/ui/button';
import { trpc } from '@/lib/trpc';

const NOTICE_CLASS =
  'border-brand-warning/30 bg-brand-gold-100 text-brand-gold-800 rounded-xl border p-3 text-sm font-medium';

function describeChangeError(error: unknown): string {
  if (error instanceof TRPCClientError) {
    const status = error.data?.httpStatus;
    if (status === 429) return 'Too many attempts. Wait a few minutes and try again.';
    if (status === 400) return 'Please check the new password and try again.';
    if (typeof status === 'number' && status < 500) return error.message;
  }
  return 'Could not change the password. Nothing was changed.';
}

export default function AdminChangePasswordPage() {
  const navigate = useNavigate();
  const utils = trpc.useUtils();
  const me = trpc.staffAuth.me.useQuery(undefined, { retry: false });
  const forced = me.data?.mustChangePassword === true;

  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [banner, setBanner] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  const change = trpc.staffAuth.changePassword.useMutation({
    onSuccess: async () => {
      setCurrentPassword('');
      setNewPassword('');
      setConfirmPassword('');
      setErrors({});
      setBanner(null);
      // The flag is cleared server-side; refetch so the layout lets go.
      await utils.staffAuth.me.invalidate();
      if (forced) {
        navigate('/admin', { replace: true });
      } else {
        setDone(true);
      }
    },
    onError: (error) => {
      setDone(false);
      setBanner(describeChangeError(error));
    },
  });

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBanner(null);
    setDone(false);

    const next: Record<string, string> = {};
    if (currentPassword.length === 0) next.currentPassword = 'Enter your current password.';
    const length = staffPasswordSchema.safeParse(newPassword);
    if (!length.success) next.newPassword = length.error.issues[0]?.message ?? 'Invalid password.';
    else if (newPassword === currentPassword) {
      next.newPassword = 'Choose a password you are not using now.';
    }
    if (confirmPassword !== newPassword)
      next.confirmPassword = 'The two new passwords do not match.';

    setErrors(next);
    if (Object.keys(next).length > 0) return;
    change.mutate({ currentPassword, newPassword });
  }

  return (
    <div className="flex max-w-md flex-col gap-6">
      <header className="flex flex-col gap-1">
        <p className="text-brand-gold-700 text-xs font-semibold uppercase tracking-[0.08em]">
          Your account
        </p>
        <h1 className="text-brand-ink text-2xl font-bold sm:text-3xl">
          {forced ? 'Set a new password' : 'Change password'}
        </h1>
        <p className="text-brand-error text-sm">
          {forced
            ? 'You signed in with a temporary password. Choose your own to continue — nothing else is available until you do.'
            : 'Choose a new password. Any other device you are signed in on will be signed out.'}
        </p>
      </header>

      {done ? (
        <p
          role="status"
          className="bg-brand-blue-50 text-brand-blue-900 border-brand-blue-200 rounded-xl border p-3 text-sm font-medium"
        >
          Your password was changed. Your other sign-ins were ended.
        </p>
      ) : null}

      <form
        onSubmit={onSubmit}
        noValidate
        className="border-brand-blue-100 space-y-5 rounded-[14px] border bg-white p-5"
      >
        {banner ? (
          <p role="alert" className={NOTICE_CLASS}>
            {banner}
          </p>
        ) : null}

        <PasswordField
          label={forced ? 'Temporary password' : 'Current password'}
          value={currentPassword}
          onChange={setCurrentPassword}
          autoComplete="current-password"
          error={errors.currentPassword}
        />
        <PasswordField
          label="New password"
          value={newPassword}
          onChange={setNewPassword}
          autoComplete="new-password"
          hint={`At least ${STAFF_PASSWORD_MIN_LENGTH} characters, and different from the one you have now.`}
          error={errors.newPassword}
        />
        <PasswordField
          label="Confirm new password"
          value={confirmPassword}
          onChange={setConfirmPassword}
          autoComplete="new-password"
          error={errors.confirmPassword}
        />

        <Button
          type="submit"
          disabled={change.isPending}
          className="tap-target bg-brand-blue-700 hover:bg-brand-blue-800 w-full rounded-[10px] font-semibold text-white transition-colors"
        >
          {change.isPending ? (
            <>
              <Loader2 className="mr-2 size-4 animate-spin" aria-hidden="true" />
              Saving…
            </>
          ) : (
            'Save new password'
          )}
        </Button>
      </form>
    </div>
  );
}
