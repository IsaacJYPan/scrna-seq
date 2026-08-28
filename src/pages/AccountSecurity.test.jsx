import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import AccountSecurity from './AccountSecurity';

describe('AccountSecurity', () => {
  beforeEach(() => {
    window.electronAPI = { changePassword: vi.fn() };
  });

  it('requires a matching 15-character replacement before submission', () => {
    render(<AccountSecurity user={{ email: 'owner@example.org' }} />);
    fireEvent.change(screen.getByLabelText('Current password'), { target: { value: 'old password' } });
    fireEvent.change(screen.getByLabelText('New password'), { target: { value: 'too short' } });
    fireEvent.change(screen.getByLabelText('Confirm new password'), { target: { value: 'different' } });

    expect(screen.getByText(/add 6 more characters/i)).toBeInTheDocument();
    expect(screen.getByText(/do not match/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /update password/i })).toBeDisabled();
  });

  it('updates the credential and explains session revocation', async () => {
    const updatedUser = { id: 1, email: 'owner@example.org', displayName: 'Owner' };
    window.electronAPI.changePassword.mockResolvedValue(updatedUser);
    const onPasswordChanged = vi.fn();
    render(<AccountSecurity user={updatedUser} onPasswordChanged={onPasswordChanged} />);

    fireEvent.change(screen.getByLabelText('Current password'), { target: { value: 'old private password' } });
    fireEvent.change(screen.getByLabelText('New password'), { target: { value: 'violet harbor orbits calmly' } });
    fireEvent.change(screen.getByLabelText('Confirm new password'), { target: { value: 'violet harbor orbits calmly' } });
    fireEvent.click(screen.getByRole('button', { name: /update password/i }));

    await waitFor(() => expect(window.electronAPI.changePassword).toHaveBeenCalledWith(
      'old private password', 'violet harbor orbits calmly'
    ));
    expect(await screen.findByText(/other signed-in sessions were revoked/i)).toBeInTheDocument();
    expect(onPasswordChanged).toHaveBeenCalledWith(updatedUser);
  });

  it('returns to sign-in when the session changed during the request', async () => {
    window.electronAPI.changePassword.mockResolvedValue({ status: 401, error: 'Sign in again.' });
    const onSessionInvalid = vi.fn();
    render(<AccountSecurity user={{ email: 'owner@example.org' }} onSessionInvalid={onSessionInvalid} />);

    fireEvent.change(screen.getByLabelText('Current password'), { target: { value: 'old private password' } });
    fireEvent.change(screen.getByLabelText('New password'), { target: { value: 'violet harbor orbits calmly' } });
    fireEvent.change(screen.getByLabelText('Confirm new password'), { target: { value: 'violet harbor orbits calmly' } });
    fireEvent.click(screen.getByRole('button', { name: /update password/i }));

    await waitFor(() => expect(onSessionInvalid).toHaveBeenCalledWith('Sign in again.'));
  });
});
