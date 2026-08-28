import React, { useState } from 'react';
import { CheckCircle2, Eye, EyeOff, KeyRound, ShieldCheck } from 'lucide-react';
import passwordPolicy from '../../shared/passwordPolicyContract.json';

function PasswordField({ id, label, value, onChange, autoComplete }) {
  const [visible, setVisible] = useState(false);
  return (
    <div className="space-y-1.5">
      <label htmlFor={id} className="text-sm font-semibold text-text">{label}</label>
      <div className="relative">
        <input
          id={id}
          type={visible ? 'text' : 'password'}
          value={value}
          onChange={(event) => onChange(event.target.value)}
          autoComplete={autoComplete}
          maxLength={passwordPolicy.maxLength}
          className="w-full rounded-lg border border-border bg-background px-3 py-2.5 pr-11 text-sm text-text outline-none transition-colors focus:border-primary"
        />
        <button
          type="button"
          className="absolute inset-y-0 right-0 flex w-11 items-center justify-center text-textMuted hover:text-text"
          onClick={() => setVisible((current) => !current)}
          aria-label={visible ? `Hide ${label.toLowerCase()}` : `Show ${label.toLowerCase()}`}
        >
          {visible ? <EyeOff size={17} /> : <Eye size={17} />}
        </button>
      </div>
    </div>
  );
}

export default function AccountSecurity({ user, onPasswordChanged, onSessionInvalid }) {
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [status, setStatus] = useState({ phase: 'idle', message: '' });

  const newPasswordLength = Array.from(newPassword).length;
  const meetsLength = newPasswordLength >= passwordPolicy.minLength;
  const confirmationMatches = confirmation.length > 0 && confirmation === newPassword;
  const canSubmit = currentPassword.length > 0
    && meetsLength
    && confirmationMatches
    && currentPassword !== newPassword
    && status.phase !== 'saving';

  const submit = async (event) => {
    event.preventDefault();
    if (!canSubmit) return;
    setStatus({ phase: 'saving', message: 'Updating password…' });
    const result = await window.electronAPI.changePassword(currentPassword, newPassword);
    if (result?.status === 401) {
      onSessionInvalid?.(result.error);
      return;
    }
    if (result?.error) {
      setStatus({ phase: 'error', message: result.error });
      return;
    }
    setCurrentPassword('');
    setNewPassword('');
    setConfirmation('');
    setStatus({ phase: 'success', message: 'Password updated. Other signed-in sessions were revoked.' });
    onPasswordChanged?.(result);
  };

  return (
    <div className="h-full overflow-y-auto bg-background p-6 lg:p-10">
      <div className="mx-auto max-w-3xl space-y-6">
        <header>
          <p className="mb-2 text-xs font-bold uppercase tracking-[0.16em] text-primary">Account</p>
          <h2 className="text-2xl font-bold tracking-tight text-text">Security</h2>
          <p className="mt-2 text-sm leading-6 text-textMuted">
            Manage the credential for <span className="font-medium text-text">{user?.email}</span>.
          </p>
        </header>

        <section className="rounded-xl border border-border bg-surface p-5 shadow-sm lg:p-6">
          <div className="mb-5 flex items-start gap-3">
            <div className="rounded-lg bg-primary/10 p-2 text-primary"><KeyRound size={20} /></div>
            <div>
              <h3 className="font-semibold text-text">Change password</h3>
              <p className="mt-1 text-sm leading-5 text-textMuted">
                Use at least {passwordPolicy.minLength} characters. A long, unique passphrase works well; symbols and capitalization are optional.
              </p>
            </div>
          </div>

          <form className="space-y-4" onSubmit={submit}>
            <PasswordField
              id="current-password"
              label="Current password"
              value={currentPassword}
              onChange={setCurrentPassword}
              autoComplete="current-password"
            />
            <PasswordField
              id="new-password"
              label="New password"
              value={newPassword}
              onChange={setNewPassword}
              autoComplete="new-password"
            />
            <PasswordField
              id="confirm-password"
              label="Confirm new password"
              value={confirmation}
              onChange={setConfirmation}
              autoComplete="new-password"
            />

            {newPassword && !meetsLength && (
              <p className="text-sm text-danger">Add {passwordPolicy.minLength - newPasswordLength} more characters.</p>
            )}
            {confirmation && !confirmationMatches && (
              <p className="text-sm text-danger">The new passwords do not match.</p>
            )}
            {status.message && (
              <div
                role="status"
                className={`flex items-center gap-2 rounded-lg border px-3 py-2.5 text-sm ${status.phase === 'success' ? 'border-success/30 bg-success/10 text-success' : status.phase === 'error' ? 'border-danger/30 bg-danger/10 text-danger' : 'border-border bg-background text-textMuted'}`}
              >
                {status.phase === 'success' ? <CheckCircle2 size={17} /> : <ShieldCheck size={17} />}
                {status.message}
              </div>
            )}

            <button type="submit" className="btn btn-primary" disabled={!canSubmit}>
              {status.phase === 'saving' ? 'Updating…' : 'Update password'}
            </button>
          </form>
        </section>
      </div>
    </div>
  );
}
